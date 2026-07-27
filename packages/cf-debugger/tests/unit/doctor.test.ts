import {
  access,
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CF_DEBUGGER_HOMES_DIRNAME,
  CF_DEBUGGER_LOCK_FILENAME,
  CF_DEBUGGER_STATE_FILENAME,
  CF_DEBUGGER_STOP_INTENT_PREFIX,
} from "../../src/paths.js";
import type { ActiveSession } from "../../src/types.js";

const mocks = vi.hoisted(() => ({
  inspectListeningProcesses: vi.fn(),
  inspectSessionHealth: vi.fn(),
  isPortListening: vi.fn(),
}));

vi.mock("../../src/network/ports.js", () => ({
  inspectListeningProcesses: mocks.inspectListeningProcesses,
  isPortListening: mocks.isPortListening,
}));

vi.mock("../../src/session-state/store.js", () => ({
  inspectSessionHealth: mocks.inspectSessionHealth,
}));

const { runDoctor } = await import("../../src/debug-session/doctor.js");

function createSession(home: string, overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionId: "session-a",
    pid: process.pid,
    controllerPid: process.pid,
    hostname: hostname(),
    region: "eu10",
    org: "org-a",
    space: "dev",
    app: "demo-app",
    process: "web",
    instance: 0,
    apiEndpoint: "https://api.example.com",
    localPort: 20_123,
    remotePort: 9229,
    cfHomeDir: home,
    startedAt: new Date().toISOString(),
    status: "starting",
    ...overrides,
  };
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("doctor and garbage collection", () => {
  let originalHome: string | undefined;
  let tempHome: string;
  let toolsDir: string;

  beforeEach(async (): Promise<void> => {
    originalHome = process.env["HOME"];
    tempHome = await mkdtemp(join(tmpdir(), "cf-debugger-doctor-"));
    process.env["HOME"] = tempHome;
    toolsDir = join(tempHome, ".saptools");
    await mkdir(toolsDir, { recursive: true });
    mocks.inspectSessionHealth.mockResolvedValue({
      status: "healthy",
      reason: "test session is healthy",
    });
    mocks.isPortListening.mockImplementation(
      async (port: number): Promise<boolean> => port === 20_555,
    );
    mocks.inspectListeningProcesses.mockResolvedValue({
      status: "found",
      pids: [9_001],
    });
  });

  afterEach(async (): Promise<void> => {
    vi.clearAllMocks();
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  it("reports state health, orphan homes, unclaimed ports, and legacy tokens read-only", async () => {
    const homesRoot = join(toolsDir, CF_DEBUGGER_HOMES_DIRNAME);
    const claimedHome = join(homesRoot, "session-a");
    const orphanHome = join(homesRoot, "session-orphan");
    await mkdir(claimedHome, { recursive: true });
    await mkdir(orphanHome, { recursive: true });
    const session = createSession(claimedHome);
    await writeFile(
      join(toolsDir, CF_DEBUGGER_STATE_FILENAME),
      JSON.stringify({ version: "2", sessions: [session] }),
      "utf8",
    );
    const legacyState = join(toolsDir, "cf-debugger-state.json");
    const legacyHomes = join(toolsDir, "cf-debugger-homes");
    await writeFile(legacyState, "{}", "utf8");
    await mkdir(legacyHomes);
    const corruptBackup = join(
      toolsDir,
      `${CF_DEBUGGER_STATE_FILENAME}.corrupt-2026-01-01`,
    );
    await writeFile(corruptBackup, "evidence", "utf8");

    const report = await runDoctor();

    expect(report.sessions).toEqual([{
      session,
      health: { status: "healthy", reason: "test session is healthy" },
    }]);
    expect(report.orphanHomes).toEqual([{
      sessionId: "session-orphan",
      path: orphanHome,
      cleanupEligible: true,
      cleanupStatus: "not-requested",
    }]);
    expect(report.unclaimedPorts).toEqual([{
      port: 20_555,
      pids: [9_001],
      ownerStatus: "found",
    }]);
    expect(report.artifacts).toEqual([
      expect.objectContaining({
        kind: "corrupt-backup",
        path: corruptBackup,
        cleanupEligible: false,
        cleanupStatus: "not-eligible",
      }),
    ]);
    expect(report.legacy.warning).toContain("live CF refresh and access tokens");
    expect(report.legacy.manualRemovalCommand).toContain(legacyHomes);
    expect(report.legacy.manualRemovalCommand).toContain(legacyState);
    expect(report.legacy.manualRemovalCommand).toContain(
      join(toolsDir, "cf-debugger-state.lock"),
    );
    expect(report.cleanedPaths).toEqual([]);
    expect(mocks.isPortListening).not.toHaveBeenCalledWith(20_123);
    await expect(access(orphanHome)).resolves.toBeUndefined();
    await expect(access(legacyHomes)).resolves.toBeUndefined();
    await expect(access(corruptBackup)).resolves.toBeUndefined();
  });

  it("cleans only canonical orphan homes and stale package-owned artifacts", async () => {
    mocks.isPortListening.mockResolvedValue(false);
    const homesRoot = join(toolsDir, CF_DEBUGGER_HOMES_DIRNAME);
    const orphanHome = join(homesRoot, "safe-orphan");
    const unsafeHome = join(homesRoot, "unsafe name");
    await mkdir(orphanHome, { recursive: true });
    await mkdir(unsafeHome, { recursive: true });

    const tempArtifact = join(
      toolsDir,
      `${CF_DEBUGGER_STATE_FILENAME}.test-uuid.tmp`,
    );
    const staleRecovery = join(
      toolsDir,
      `${CF_DEBUGGER_LOCK_FILENAME}.recovery`,
    );
    const corruptBackup = join(toolsDir, `${CF_DEBUGGER_STATE_FILENAME}.corrupt-test`);
    const stopIntent = join(
      toolsDir,
      `${CF_DEBUGGER_STOP_INTENT_PREFIX}orphan-session.stop`,
    );
    await writeFile(tempArtifact, "partial", "utf8");
    await writeFile(staleRecovery, "malformed", "utf8");
    await writeFile(corruptBackup, "evidence", "utf8");
    await writeFile(stopIntent, "", "utf8");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    await Promise.all([
      utimes(tempArtifact, old, old),
      utimes(staleRecovery, old, old),
      utimes(corruptBackup, old, old),
      utimes(stopIntent, old, old),
    ]);

    const legacyState = join(toolsDir, "cf-debugger-state.json");
    const legacyHomes = join(toolsDir, "cf-debugger-homes");
    await writeFile(legacyState, "{}", "utf8");
    await mkdir(legacyHomes);

    const report = await runDoctor({ cleanup: true });

    await expectMissing(orphanHome);
    await expectMissing(tempArtifact);
    await expectMissing(staleRecovery);
    await expect(access(unsafeHome)).resolves.toBeUndefined();
    await expect(access(corruptBackup)).resolves.toBeUndefined();
    await expectMissing(stopIntent);
    await expect(access(legacyState)).resolves.toBeUndefined();
    await expect(access(legacyHomes)).resolves.toBeUndefined();
    expect(report.cleanedPaths).toEqual(expect.arrayContaining([
      orphanHome,
      tempArtifact,
      staleRecovery,
      stopIntent,
    ]));
    expect(report.orphanHomes).toContainEqual(expect.objectContaining({
      sessionId: "unsafe name",
      cleanupEligible: false,
      cleanupStatus: "not-eligible",
    }));
    expect(report.artifacts).toContainEqual(expect.objectContaining({
      path: corruptBackup,
      cleanupEligible: false,
      cleanupStatus: "not-eligible",
    }));
    expect(report.artifacts).toContainEqual(expect.objectContaining({
      kind: "stop-intent",
      path: stopIntent,
      cleanupStatus: "removed",
    }));
  });

  it("keeps valid state findings when another entry is malformed", async () => {
    const session = createSession(join(toolsDir, CF_DEBUGGER_HOMES_DIRNAME, "session-a"));
    const droppedHome = join(toolsDir, CF_DEBUGGER_HOMES_DIRNAME, "dropped-session");
    const droppedStopIntent = join(
      toolsDir,
      `${CF_DEBUGGER_STOP_INTENT_PREFIX}dropped-session.stop`,
    );
    await mkdir(droppedHome, { recursive: true });
    await writeFile(droppedStopIntent, "", "utf8");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    await utimes(droppedStopIntent, old, old);
    await writeFile(
      join(toolsDir, CF_DEBUGGER_STATE_FILENAME),
      JSON.stringify({ version: "2", sessions: [session, { sessionId: "dropped-session" }] }),
      "utf8",
    );
    mocks.inspectSessionHealth.mockRejectedValue(new Error("owner tool unavailable"));
    mocks.isPortListening.mockImplementation(
      async (port: number): Promise<boolean> => port === 20_556,
    );
    mocks.inspectListeningProcesses.mockResolvedValue({
      status: "unverified",
      reason: "lsof is unavailable",
    });

    const report = await runDoctor({ cleanup: true });

    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]?.health).toEqual({
      status: "unverified",
      reason: "health inspection failed: owner tool unavailable",
    });
    expect(report.warnings).toContain(
      "Dropped state entry: session[1]: invalid entry.",
    );
    expect(report.warnings).toContain(
      "Skipped orphan-home and stop-intent cleanup because debugger state was incomplete or invalid.",
    );
    await expect(access(droppedHome)).resolves.toBeUndefined();
    await expect(access(droppedStopIntent)).resolves.toBeUndefined();
    expect(report.artifacts).toContainEqual(expect.objectContaining({
      kind: "stop-intent",
      path: droppedStopIntent,
      cleanupEligible: false,
      cleanupStatus: "not-eligible",
    }));
    expect(report.unclaimedPorts).toEqual([{
      port: 20_556,
      pids: [],
      ownerStatus: "unverified",
      reason: "lsof is unavailable",
    }]);
    expect(report.legacy.warning).toBeUndefined();
  });
});
