import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CfExecContext } from "../../src/cf.js";
import type {
  ActiveSession,
  SessionKey,
  SessionStatus,
  StartDebuggerOptions,
} from "../../src/types.js";

const mocks = vi.hoisted(() => ({
  cfEnableSsh: vi.fn(),
  cfLogin: vi.fn(),
  cfRestartApp: vi.fn(),
  cfSshEnabled: vi.fn(),
  cfSshOneShot: vi.fn(),
  cfTarget: vi.fn(),
  findListeningProcessId: vi.fn(),
  isPidAlive: vi.fn(),
  isPortFree: vi.fn(),
  isSshDisabledError: vi.fn(),
  killProcessOnPort: vi.fn(),
  probeTunnelReady: vi.fn(),
  readAndPruneActiveSessions: vi.fn(),
  readSessionSnapshot: vi.fn(),
  registerNewSession: vi.fn(),
  removeSession: vi.fn(),
  resolveApiEndpoint: vi.fn(),
  sessionCfHomeDir: vi.fn(),
  spawnSshTunnel: vi.fn(),
  updateSessionPid: vi.fn(),
  updateSessionStatus: vi.fn(),
}));

vi.mock("../../src/cf.js", () => ({
  cfEnableSsh: mocks.cfEnableSsh,
  cfLogin: mocks.cfLogin,
  cfRestartApp: mocks.cfRestartApp,
  cfSshEnabled: mocks.cfSshEnabled,
  cfSshOneShot: mocks.cfSshOneShot,
  cfTarget: mocks.cfTarget,
  isSshDisabledError: mocks.isSshDisabledError,
  spawnSshTunnel: mocks.spawnSshTunnel,
}));

vi.mock("../../src/paths.js", () => ({
  sessionCfHomeDir: mocks.sessionCfHomeDir,
}));

vi.mock("../../src/port.js", () => ({
  findListeningProcessId: mocks.findListeningProcessId,
  isPortFree: mocks.isPortFree,
  killProcessOnPort: mocks.killProcessOnPort,
  probeTunnelReady: mocks.probeTunnelReady,
}));

vi.mock("../../src/regions.js", () => ({
  resolveApiEndpoint: mocks.resolveApiEndpoint,
}));

vi.mock("../../src/state.js", () => ({
  isPidAlive: mocks.isPidAlive,
  matchesKey: (session: SessionKey, key: SessionKey): boolean =>
    session.region === key.region &&
    session.org === key.org &&
    session.space === key.space &&
    session.app === key.app,
  readAndPruneActiveSessions: mocks.readAndPruneActiveSessions,
  readSessionSnapshot: mocks.readSessionSnapshot,
  registerNewSession: mocks.registerNewSession,
  removeSession: mocks.removeSession,
  sessionKeyString: (key: SessionKey): string =>
    `${key.region}:${key.org}:${key.space}:${key.app}`,
  updateSessionPid: mocks.updateSessionPid,
  updateSessionStatus: mocks.updateSessionStatus,
}));

const { getSession, listSessions, startDebugger, stopDebugger } = await import("../../src/debugger.js");

const key: SessionKey = {
  region: "eu10",
  org: "org-a",
  space: "dev",
  app: "demo-app",
};

function createChild(pid: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  });
  return child;
}

function createSession(tempDir: string, overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionId: "session-a",
    pid: process.pid,
    hostname: "host-a",
    region: key.region,
    org: key.org,
    space: key.space,
    app: key.app,
    apiEndpoint: "https://api.example.com",
    localPort: 20_123,
    remotePort: 9229,
    cfHomeDir: join(tempDir, "cf-home"),
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "starting",
    ...overrides,
  };
}

function withCredentials(options: Partial<StartDebuggerOptions> = {}): StartDebuggerOptions {
  return {
    ...key,
    email: "user@example.com",
    password: "opaque-value",
    ...options,
  };
}

describe("startDebugger orchestration", () => {
  let tempDir: string;
  let session: ActiveSession;
  let child: ChildProcess;
  let originalEmail: string | undefined;
  let originalPassword: string | undefined;

  beforeEach(async () => {
    originalEmail = process.env["SAP_EMAIL"];
    originalPassword = process.env["SAP_PASSWORD"];
    delete process.env["SAP_EMAIL"];
    delete process.env["SAP_PASSWORD"];

    tempDir = await mkdtemp(join(tmpdir(), "cf-debugger-orchestration-"));
    session = createSession(tempDir);
    child = createChild(44_001);

    mocks.resolveApiEndpoint.mockReturnValue("https://api.example.com");
    mocks.readAndPruneActiveSessions.mockResolvedValue({ sessions: [], removed: [] });
    mocks.readSessionSnapshot.mockResolvedValue([]);
    mocks.registerNewSession.mockResolvedValue({ session });
    mocks.cfLogin.mockResolvedValue(undefined);
    mocks.cfTarget.mockResolvedValue(undefined);
    mocks.cfSshOneShot.mockResolvedValue({ exitCode: 0, stderr: "" });
    mocks.cfSshEnabled.mockResolvedValue(true);
    mocks.cfEnableSsh.mockResolvedValue(undefined);
    mocks.cfRestartApp.mockResolvedValue(undefined);
    mocks.isSshDisabledError.mockImplementation((stderr: string) =>
      stderr.toLowerCase().includes("disabled"),
    );
    mocks.isPortFree.mockResolvedValue(true);
    mocks.spawnSshTunnel.mockReturnValue(child);
    mocks.probeTunnelReady.mockResolvedValue(true);
    mocks.findListeningProcessId.mockResolvedValue(55_001);
    mocks.isPidAlive.mockReturnValue(false);
    mocks.updateSessionPid.mockImplementation(async (_sessionId: string, pid: number) => {
      session = { ...session, pid };
      return session;
    });
    mocks.updateSessionStatus.mockImplementation(
      async (_sessionId: string, status: SessionStatus, message?: string) => {
        session = message === undefined ? { ...session, status } : { ...session, status, message };
        return session;
      },
    );
    mocks.removeSession.mockResolvedValue(session);
    mocks.killProcessOnPort.mockResolvedValue(undefined);
    mocks.sessionCfHomeDir.mockImplementation((id: string) => join(tempDir, id));
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (originalEmail === undefined) {
      delete process.env["SAP_EMAIL"];
    } else {
      process.env["SAP_EMAIL"] = originalEmail;
    }
    if (originalPassword === undefined) {
      delete process.env["SAP_PASSWORD"];
    } else {
      process.env["SAP_PASSWORD"] = originalPassword;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("fails before session registration when credentials are missing", async () => {
    await expect(startDebugger(key)).rejects.toMatchObject({
      code: "MISSING_CREDENTIALS",
    });
    expect(mocks.registerNewSession).not.toHaveBeenCalled();
  });

  it("starts a tunnel, records readiness, and disposes cleanup once", async () => {
    const statuses: SessionStatus[] = [];
    const handle = await startDebugger(
      withCredentials({
        onStatus: (status) => {
          statuses.push(status);
        },
      }),
    );

    expect(mocks.cfLogin).toHaveBeenCalledWith(
      "https://api.example.com",
      "user@example.com",
      "opaque-value",
      { cfHome: session.cfHomeDir } satisfies CfExecContext,
    );
    expect(mocks.cfTarget).toHaveBeenCalledWith("org-a", "dev", { cfHome: session.cfHomeDir });
    expect(mocks.cfSshOneShot).toHaveBeenCalledWith(
      "demo-app",
      "kill -s USR1 $(pidof node)",
      { cfHome: session.cfHomeDir },
    );
    expect(mocks.spawnSshTunnel).toHaveBeenCalledWith("demo-app", 20_123, 9229, {
      cfHome: session.cfHomeDir,
    });
    expect(handle.session.status).toBe("ready");
    expect(handle.session.pid).toBe(55_001);
    expect(statuses).toEqual(["logging-in", "targeting", "signaling", "tunneling", "ready"]);

    await handle.dispose();
    await handle.dispose();

    expect(mocks.updateSessionStatus).toHaveBeenCalledWith("session-a", "stopping");
    expect(mocks.removeSession).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate sessions before calling CF", async () => {
    mocks.registerNewSession.mockResolvedValue({ session, existing: session });

    await expect(startDebugger(withCredentials())).rejects.toMatchObject({
      code: "SESSION_ALREADY_RUNNING",
    });
    expect(mocks.cfLogin).not.toHaveBeenCalled();
  });

  it("enables SSH, restarts, and retries the signal when the first signal is rejected", async () => {
    mocks.cfSshOneShot
      .mockResolvedValueOnce({ exitCode: 1, stderr: "SSH support is disabled" })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "" });
    mocks.cfSshEnabled.mockResolvedValue(false);
    const statuses: SessionStatus[] = [];

    const handle = await startDebugger(
      withCredentials({
        onStatus: (status) => {
          statuses.push(status);
        },
      }),
    );

    expect(handle.session.status).toBe("ready");
    expect(mocks.cfEnableSsh).toHaveBeenCalledWith("demo-app", { cfHome: session.cfHomeDir });
    expect(mocks.cfRestartApp).toHaveBeenCalledWith("demo-app", { cfHome: session.cfHomeDir });
    expect(mocks.cfSshOneShot).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual([
      "logging-in",
      "targeting",
      "signaling",
      "ssh-enabling",
      "ssh-restarting",
      "signaling",
      "tunneling",
      "ready",
    ]);

    await handle.dispose();
  });

  it("cleans up and reports USR1 failures", async () => {
    mocks.cfSshOneShot.mockResolvedValue({ exitCode: 1, stderr: "no node process" });
    mocks.isSshDisabledError.mockReturnValue(false);

    await expect(startDebugger(withCredentials())).rejects.toMatchObject({
      code: "USR1_SIGNAL_FAILED",
    });
    expect(mocks.spawnSshTunnel).not.toHaveBeenCalled();
    expect(mocks.removeSession).toHaveBeenCalledWith("session-a");
  });

  it("cleans up when the tunnel never becomes ready", async () => {
    mocks.probeTunnelReady.mockResolvedValue(false);
    mocks.isPidAlive.mockReturnValueOnce(true).mockReturnValue(false);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      await expect(
        startDebugger(withCredentials({ tunnelReadyTimeoutMs: 1 })),
      ).rejects.toMatchObject({
        code: "TUNNEL_NOT_READY",
      });
      expect(mocks.spawnSshTunnel).toHaveBeenCalled();
      expect(killSpy).toHaveBeenCalledWith(process.platform === "win32" ? 44_001 : -44_001, "SIGTERM");
      expect(mocks.removeSession).toHaveBeenCalledWith("session-a");
    } finally {
      killSpy.mockRestore();
    }
  });

  it("aborts before creating a session when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(startDebugger(withCredentials({ signal: controller.signal }))).rejects.toMatchObject({
      code: "ABORTED",
    });
    expect(mocks.registerNewSession).not.toHaveBeenCalled();
  });
});

describe("stopDebugger", () => {
  let tempDir: string;
  let session: ActiveSession;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cf-debugger-stop-"));
    session = createSession(tempDir, { pid: 77_001, status: "ready" });
    mocks.readAndPruneActiveSessions.mockResolvedValue({ sessions: [session], removed: [] });
    mocks.isPidAlive.mockReturnValue(false);
    mocks.removeSession.mockResolvedValue(session);
    mocks.killProcessOnPort.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns undefined when no session matches", async () => {
    mocks.readAndPruneActiveSessions.mockResolvedValue({ sessions: [], removed: [] });

    await expect(stopDebugger({ sessionId: "missing" })).resolves.toBeUndefined();
    expect(mocks.removeSession).not.toHaveBeenCalled();
  });

  it("removes a matching session by key", async () => {
    const removed = await stopDebugger({ key });

    expect(removed?.sessionId).toBe("session-a");
    expect(mocks.removeSession).toHaveBeenCalledWith("session-a");
  });
});

describe("session readers", () => {
  let tempDir: string;
  let session: ActiveSession;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cf-debugger-readers-"));
    session = createSession(tempDir, { pid: 77_001, status: "ready" });
    mocks.readAndPruneActiveSessions.mockResolvedValue({ sessions: [], removed: [session] });
    mocks.readSessionSnapshot.mockResolvedValue([session]);
    mocks.killProcessOnPort.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("lists stored sessions without orphan cleanup side effects", async () => {
    await expect(listSessions()).resolves.toEqual([session]);

    expect(mocks.readSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.readAndPruneActiveSessions).not.toHaveBeenCalled();
    expect(mocks.killProcessOnPort).not.toHaveBeenCalled();
  });

  it("gets a stored session without orphan cleanup side effects", async () => {
    await expect(getSession(key)).resolves.toEqual(session);

    expect(mocks.readSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.readAndPruneActiveSessions).not.toHaveBeenCalled();
    expect(mocks.killProcessOnPort).not.toHaveBeenCalled();
  });
});
