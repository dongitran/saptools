import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActiveSession } from "../../src/types.js";

const mocks = vi.hoisted(() => ({
  isOwnedSessionCfHomeDir: vi.fn(),
  readAndPruneActiveSessions: vi.fn(),
}));

vi.mock("../../src/paths.js", () => ({
  isOwnedSessionCfHomeDir: mocks.isOwnedSessionCfHomeDir,
}));

vi.mock("../../src/state.js", () => ({
  readAndPruneActiveSessions: mocks.readAndPruneActiveSessions,
}));

const { pruneAndCleanupOrphans } = await import("../../src/debug-session/orphans.js");

function createSession(tempDir: string, overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionId: "session-a",
    pid: process.pid,
    controllerPid: process.pid,
    tunnelPid: process.pid,
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
    cfHomeDir: join(tempDir, "session-a"),
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "ready",
    ...overrides,
  };
}

describe("orphan CF home cleanup", () => {
  let tempDir: string;

  beforeEach(async (): Promise<void> => {
    tempDir = await mkdtemp(join(tmpdir(), "cf-debugger-orphans-"));
  });

  afterEach(async (): Promise<void> => {
    vi.clearAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("removes the canonical home of a pruned local session", async (): Promise<void> => {
    const removed = createSession(tempDir);
    await mkdir(removed.cfHomeDir, { recursive: true });
    mocks.isOwnedSessionCfHomeDir.mockReturnValue(true);
    mocks.readAndPruneActiveSessions.mockResolvedValue({ sessions: [], removed: [removed] });

    await expect(pruneAndCleanupOrphans()).resolves.toEqual({ sessions: [], removed: [removed] });

    await expect(access(removed.cfHomeDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps unowned and foreign-host homes", async (): Promise<void> => {
    const unowned = createSession(tempDir, { cfHomeDir: join(tempDir, "unowned") });
    const foreign = createSession(tempDir, {
      sessionId: "session-b",
      hostname: "another-host",
      cfHomeDir: join(tempDir, "foreign"),
    });
    await mkdir(unowned.cfHomeDir, { recursive: true });
    await mkdir(foreign.cfHomeDir, { recursive: true });
    mocks.isOwnedSessionCfHomeDir.mockImplementation(
      (_sessionId: string, candidate: string) => candidate === foreign.cfHomeDir,
    );
    mocks.readAndPruneActiveSessions.mockResolvedValue({
      sessions: [],
      removed: [unowned, foreign],
    });

    await pruneAndCleanupOrphans();

    await expect(access(unowned.cfHomeDir)).resolves.toBeUndefined();
    await expect(access(foreign.cfHomeDir)).resolves.toBeUndefined();
  });

  it("treats filesystem cleanup failures as best effort", async (): Promise<void> => {
    const removed = createSession(tempDir, { cfHomeDir: "\0invalid-path" });
    mocks.isOwnedSessionCfHomeDir.mockReturnValue(true);
    mocks.readAndPruneActiveSessions.mockResolvedValue({ sessions: [], removed: [removed] });

    await expect(pruneAndCleanupOrphans()).resolves.toEqual({ sessions: [], removed: [removed] });
  });
});
