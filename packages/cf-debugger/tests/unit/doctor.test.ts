import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import nodeProcess from "node:process";

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
    controllerProcessIdentity: "test-controller-identity",
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
    vi.restoreAllMocks();
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
        note: expect.stringContaining("debugger session metadata"),
        manualRemovalCommand: `rm -- '${corruptBackup}'`,
      }),
    ]);
    expect(report.legacy.warning).toContain("live CF refresh and access tokens");
    expect(report.legacy.inspectionWarnings).toEqual([
      "Legacy v1 state has an invalid structure.",
    ]);
    expect(report.legacy.sessions).toBeUndefined();
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
      note: expect.stringContaining("Preserved recovery evidence"),
      manualRemovalCommand: `rm -- '${corruptBackup}'`,
    }));
    expect(report.artifacts).toContainEqual(expect.objectContaining({
      kind: "stop-intent",
      path: stopIntent,
      cleanupStatus: "removed",
    }));
  });

  it("refuses a symlinked homes root without touching its external target", async () => {
    mocks.isPortListening.mockResolvedValue(false);
    const outside = join(tempHome, "outside-homes");
    const externalHome = join(outside, "external-session");
    const sentinel = join(externalHome, "SENTINEL.txt");
    await mkdir(externalHome, { recursive: true });
    await writeFile(sentinel, "keep", "utf8");
    await symlink(outside, join(toolsDir, CF_DEBUGGER_HOMES_DIRNAME), "dir");

    const report = await runDoctor({ cleanup: true });

    expect(report.orphanHomes).toEqual([]);
    expect(report.warnings).toContainEqual(
      expect.stringContaining("is a symbolic link; refusing to traverse it"),
    );
    await expect(access(sentinel)).resolves.toBeUndefined();
  });

  it("reports non-directory home entries but never removes them", async () => {
    mocks.isPortListening.mockResolvedValue(false);
    const homesRoot = join(toolsDir, CF_DEBUGGER_HOMES_DIRNAME);
    const strayFile = join(homesRoot, "stray-session");
    const linkedEntry = join(homesRoot, "linked-session");
    await mkdir(homesRoot, { recursive: true });
    await writeFile(strayFile, "metadata", "utf8");
    await symlink(strayFile, linkedEntry);

    const report = await runDoctor({ cleanup: true });

    expect(report.orphanHomes).toEqual([
      {
        sessionId: "linked-session",
        path: linkedEntry,
        cleanupEligible: false,
        cleanupStatus: "not-eligible",
        reason: "entry is a symbolic link, not a debugger CF home directory",
      },
      {
        sessionId: "stray-session",
        path: strayFile,
        cleanupEligible: false,
        cleanupStatus: "not-eligible",
        reason: "entry is not a directory",
      },
    ]);
    await expect(access(strayFile)).resolves.toBeUndefined();
    await expect(access(linkedEntry)).resolves.toBeUndefined();
  });

  it("reports PID-only compatibility when an identity token is absent", async () => {
    mocks.isPortListening.mockResolvedValue(false);
    const homesRoot = join(toolsDir, CF_DEBUGGER_HOMES_DIRNAME);
    const startingWithIdentity = createSession(join(homesRoot, "starting-session"), {
      sessionId: "starting-session",
    });
    const { controllerProcessIdentity, ...starting } = startingWithIdentity;
    expect(controllerProcessIdentity).toBe("test-controller-identity");
    const ready = createSession(join(homesRoot, "ready-session"), {
      sessionId: "ready-session",
      status: "ready",
      tunnelPid: process.pid,
    });
    await writeFile(
      join(toolsDir, CF_DEBUGGER_STATE_FILENAME),
      JSON.stringify({ version: "2", sessions: [starting, ready] }),
      "utf8",
    );

    const report = await runDoctor();

    for (const finding of report.sessions) {
      if (process.platform === "linux" || process.platform === "darwin") {
        expect(finding.health.reason).toContain("PID-only compatibility is in use");
        expect(finding.health.reason).toContain("older cf-debugger");
      } else {
        expect(finding.health.reason).toBe("test session is healthy");
      }
    }
  });

  it("reports legacy home count and claimed session liveness without mutating v1 artifacts", async () => {
    mocks.isPortListening.mockResolvedValue(false);
    const alivePid = 41_001;
    const deadPid = 41_002;
    const foreignPid = 41_003;
    const killSpy = vi.spyOn(nodeProcess, "kill").mockImplementation((pid, signal): true => {
      expect(signal).toBe(0);
      if (pid === alivePid) {
        return true;
      }
      if (pid === deadPid) {
        const error = new Error("no such process");
        Object.defineProperty(error, "code", { value: "ESRCH" });
        throw error;
      }
      throw new Error(`Unexpected PID probe: ${pid.toString()}`);
    });
    const legacyStatePath = join(toolsDir, "cf-debugger-state.json");
    const legacyHomesPath = join(toolsDir, "cf-debugger-homes");
    const firstHome = join(legacyHomesPath, "legacy-alive");
    const secondHome = join(legacyHomesPath, "legacy-dead");
    const sentinel = join(firstHome, "SENTINEL.txt");
    await mkdir(firstHome, { recursive: true });
    await mkdir(secondHome, { recursive: true });
    await writeFile(sentinel, "keep", "utf8");
    await writeFile(join(legacyHomesPath, "README.txt"), "not a home", "utf8");
    const legacyState = `${JSON.stringify({
      version: "1",
      sessions: [
        {
          sessionId: "legacy-alive",
          pid: alivePid,
          localPort: 29_991,
          hostname: hostname(),
        },
        {
          sessionId: "legacy-dead",
          pid: deadPid,
          localPort: 29_992,
          hostname: hostname(),
        },
        {
          sessionId: "legacy-foreign",
          pid: foreignPid,
          localPort: 29_993,
          hostname: "other-host",
        },
        "malformed",
      ],
    }, null, 2)}\n`;
    await writeFile(legacyStatePath, legacyState, "utf8");

    const report = await runDoctor({ cleanup: true });

    expect(report.legacy.homeCount).toBe(2);
    expect(report.legacy.sessions).toEqual([
      {
        index: 0,
        sessionId: "legacy-alive",
        pid: alivePid,
        localPort: 29_991,
        hostname: hostname(),
        liveness: "alive",
        reason: "PID exists, but v1 state cannot prove process identity or tunnel ownership",
      },
      {
        index: 1,
        sessionId: "legacy-dead",
        pid: deadPid,
        localPort: 29_992,
        hostname: hostname(),
        liveness: "not-running",
      },
      {
        index: 2,
        sessionId: "legacy-foreign",
        pid: foreignPid,
        localPort: 29_993,
        hostname: "other-host",
        liveness: "unverified",
        reason: "legacy session belongs to host other-host; local PID was not probed",
      },
      {
        index: 3,
        liveness: "unverified",
        reason: "legacy session entry is not an object",
      },
    ]);
    expect(killSpy.mock.calls).toEqual([
      [alivePid, 0],
      [deadPid, 0],
    ]);
    await expect(access(sentinel)).resolves.toBeUndefined();
    await expect(readFile(legacyStatePath, "utf8")).resolves.toBe(legacyState);
    expect(report.cleanedPaths).not.toContain(firstHome);
    expect(report.cleanedPaths).not.toContain(legacyStatePath);
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
    expect(report.orphanHomes).toContainEqual({
      sessionId: "dropped-session",
      path: droppedHome,
      cleanupEligible: true,
      cleanupStatus: "skipped",
    });
    expect(report.artifacts).toContainEqual(expect.objectContaining({
      kind: "stop-intent",
      path: droppedStopIntent,
      cleanupEligible: false,
      cleanupStatus: "skipped",
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
