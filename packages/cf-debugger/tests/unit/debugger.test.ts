import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
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
  isPortListening: vi.fn(),
  isSshDisabledError: vi.fn(),
  probeTunnelReady: vi.fn(),
  readActiveSessions: vi.fn(),
  readAndPruneActiveSessions: vi.fn(),
  readSessionSnapshot: vi.fn(),
  registerNewSession: vi.fn(),
  removeSession: vi.fn(),
  requestSessionStop: vi.fn(),
  resolveApiEndpoint: vi.fn(),
  sessionCfHomeDir: vi.fn(),
  spawnSshTunnel: vi.fn(),
  updateSessionPid: vi.fn(),
  updateSessionRemoteNodePid: vi.fn(),
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
  isOwnedSessionCfHomeDir: (sessionId: string, candidate: string): boolean =>
    candidate === mocks.sessionCfHomeDir(sessionId),
  sessionCfHomeDir: mocks.sessionCfHomeDir,
}));

vi.mock("../../src/port.js", () => ({
  findListeningProcessId: mocks.findListeningProcessId,
  isPortFree: mocks.isPortFree,
  isPortListening: mocks.isPortListening,
  probeTunnelReady: mocks.probeTunnelReady,
}));

vi.mock("../../src/regions.js", () => ({
  resolveApiEndpoint: mocks.resolveApiEndpoint,
}));

vi.mock("../../src/state.js", () => ({
  isPidAlive: mocks.isPidAlive,
  isPidOrGroupAlive: (pid: number): boolean => {
    if (mocks.isPidAlive(pid) === true) {
      return true;
    }
    return process.platform !== "win32" && mocks.isPidAlive(-pid) === true;
  },
  isProcessGroupAlive: (pid: number): boolean => {
    return process.platform !== "win32" && mocks.isPidAlive(-pid) === true;
  },
  matchesKey: (session: SessionKey, key: SessionKey): boolean =>
    session.region === key.region &&
    session.org === key.org &&
    session.space === key.space &&
    session.app === key.app &&
    (session.process ?? "web") === (key.process ?? "web") &&
    (session.instance ?? 0) === (key.instance ?? 0),
  readActiveSessions: mocks.readActiveSessions,
  readAndPruneActiveSessions: mocks.readAndPruneActiveSessions,
  readSessionSnapshot: mocks.readSessionSnapshot,
  registerNewSession: mocks.registerNewSession,
  removeSession: mocks.removeSession,
  requestSessionStop: mocks.requestSessionStop,
  sessionKeyString: (key: SessionKey): string =>
    `${key.region}:${key.org}:${key.space}:${key.app}`,
  updateSessionPid: mocks.updateSessionPid,
  updateSessionRemoteNodePid: mocks.updateSessionRemoteNodePid,
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
  const session: ActiveSession = {
    sessionId: "session-a",
    pid: process.pid,
    controllerPid: process.pid,
    hostname: hostname(),
    region: key.region,
    org: key.org,
    space: key.space,
    app: key.app,
    process: "web",
    instance: 0,
    apiEndpoint: "https://api.example.com",
    localPort: 20_123,
    remotePort: 9229,
    cfHomeDir: join(tempDir, "cf-home"),
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "starting",
    ...overrides,
  };
  return session.status === "ready" && session.tunnelPid === undefined
    ? { ...session, tunnelPid: session.pid }
    : session;
}

function withCredentials(options: Partial<StartDebuggerOptions> = {}): StartDebuggerOptions {
  return {
    ...key,
    email: "user@example.com",
    password: "opaque-value",
    ...options,
  };
}

async function withSuccessfulTunnelTermination(
  pid: number,
  action: () => Promise<void>,
): Promise<void> {
  const targetPid = process.platform === "win32" ? pid : -pid;
  let alive = true;
  mocks.isPidAlive.mockImplementation((candidate: number) => candidate === targetPid && alive);
  const killSpy = vi.spyOn(process, "kill").mockImplementation((candidate, signal) => {
    if (candidate === targetPid && signal === "SIGTERM") {
      alive = false;
    }
    return true;
  });
  try {
    await action();
    expect(killSpy).toHaveBeenCalledWith(targetPid, "SIGTERM");
  } finally {
    killSpy.mockRestore();
  }
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
    mocks.readActiveSessions.mockResolvedValue([]);
    mocks.readAndPruneActiveSessions.mockResolvedValue({ sessions: [], removed: [] });
    mocks.readSessionSnapshot.mockImplementation(async () => [session]);
    mocks.registerNewSession.mockResolvedValue({ session });
    mocks.cfLogin.mockResolvedValue(undefined);
    mocks.cfTarget.mockResolvedValue(undefined);
    mocks.cfSshOneShot.mockResolvedValue({
      exitCode: 0,
      stdout: [
        "saptools-inspector-node-pid=4312",
        "saptools-inspector-owner-pid=4312",
        "saptools-inspector-ready",
      ].join("\n"),
      stderr: "",
      outputTruncated: false,
    });
    mocks.cfSshEnabled.mockResolvedValue(true);
    mocks.cfEnableSsh.mockResolvedValue(undefined);
    mocks.cfRestartApp.mockResolvedValue(undefined);
    mocks.isSshDisabledError.mockImplementation((stderr: string) =>
      stderr.toLowerCase().includes("disabled"),
    );
    mocks.isPortFree.mockResolvedValue(true);
    mocks.spawnSshTunnel.mockReturnValue(child);
    mocks.probeTunnelReady.mockResolvedValue(true);
    mocks.findListeningProcessId.mockResolvedValue(44_001);
    mocks.isPidAlive.mockReturnValue(false);
    mocks.updateSessionPid.mockImplementation(async (_sessionId: string, pid: number) => {
      session = { ...session, pid, tunnelPid: pid };
      return session;
    });
    mocks.updateSessionRemoteNodePid.mockImplementation(
      async (_sessionId: string, remoteNodePid: number) => {
        session = { ...session, remoteNodePid };
        return session;
      },
    );
    mocks.updateSessionStatus.mockImplementation(
      async (_sessionId: string, status: SessionStatus, message?: string) => {
        session = message === undefined ? { ...session, status } : { ...session, status, message };
        return session;
      },
    );
    mocks.removeSession.mockResolvedValue(session);
    mocks.requestSessionStop.mockImplementation(async () => ({
      session: session.status === "ready"
        ? session
        : { ...session, stopRequestedAt: "2026-01-01T00:00:01.000Z" },
      previousStatus: session.status,
    }));
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
      expect.objectContaining({ cfHome: session.cfHomeDir }) satisfies Partial<CfExecContext>,
    );
    expect(mocks.cfTarget).toHaveBeenCalledWith(
      "org-a",
      "dev",
      expect.objectContaining({ cfHome: session.cfHomeDir }),
    );
    expect(mocks.cfSshOneShot).toHaveBeenCalledWith(
      "demo-app",
      expect.stringContaining("/proc/[0-9]*"),
      expect.objectContaining({ cfHome: session.cfHomeDir }),
      expect.objectContaining({ process: "web", instance: 0 }),
    );
    expect(mocks.spawnSshTunnel).toHaveBeenCalledWith(
      "demo-app",
      20_123,
      9229,
      expect.objectContaining({ cfHome: session.cfHomeDir }),
      { process: "web", instance: 0 },
    );
    expect(mocks.probeTunnelReady).toHaveBeenCalledWith(
      20_123,
      180_000,
      expect.any(AbortSignal),
    );
    expect(handle.session.status).toBe("ready");
    expect(handle.session.pid).toBe(44_001);
    expect(handle.session.remoteNodePid).toBe(4312);
    expect(statuses).toEqual(["logging-in", "targeting", "signaling", "tunneling", "ready"]);

    await handle.dispose();
    await handle.dispose();

    expect(mocks.updateSessionStatus).toHaveBeenCalledWith("session-a", "stopping");
    expect(mocks.removeSession).toHaveBeenCalledTimes(1);
  });

  it("restricts an existing per-session CF home to its owner", async () => {
    await mkdir(session.cfHomeDir, { recursive: true });
    await chmod(session.cfHomeDir, 0o755);

    const handle = await startDebugger(withCredentials());

    expect((await stat(session.cfHomeDir)).mode & 0o777).toBe(0o700);
    await handle.dispose();
  });

  it("uses one custom process-instance target and explicit Node PID end to end", async () => {
    const handle = await startDebugger(withCredentials({
      process: "worker",
      instance: 2,
      nodePid: 9876,
    }));

    expect(mocks.registerNewSession).toHaveBeenCalledWith(expect.objectContaining({
      process: "worker",
      instance: 2,
    }));
    expect(mocks.cfSshOneShot).toHaveBeenCalledWith(
      "demo-app",
      expect.stringContaining("requested_node_pid=9876"),
      expect.objectContaining({ cfHome: session.cfHomeDir }),
      expect.objectContaining({ process: "worker", instance: 2 }),
    );
    expect(mocks.spawnSshTunnel).toHaveBeenCalledWith(
      "demo-app",
      20_123,
      9229,
      expect.objectContaining({ cfHome: session.cfHomeDir }),
      { process: "worker", instance: 2 },
    );
    expect(handle.session.remoteNodePid).toBe(4312);

    await handle.dispose();
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
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "SSH support is disabled",
        outputTruncated: false,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: [
          "saptools-inspector-node-pid=4312",
          "saptools-inspector-owner-pid=4312",
          "saptools-inspector-ready",
        ].join("\n"),
        stderr: "",
        outputTruncated: false,
      });
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
    expect(mocks.cfEnableSsh).toHaveBeenCalledWith(
      "demo-app",
      expect.objectContaining({ cfHome: session.cfHomeDir }),
    );
    expect(mocks.cfRestartApp).toHaveBeenCalledWith(
      "demo-app",
      expect.objectContaining({ cfHome: session.cfHomeDir }),
    );
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

  it("fails without mutating the app when automatic SSH enable and restart are disabled", async () => {
    mocks.cfSshOneShot.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "SSH support is disabled",
      outputTruncated: false,
    });

    await expect(startDebugger(withCredentials({
      allowSshEnableRestart: false,
      nodePid: 9876,
    }))).rejects.toMatchObject({
      code: "SSH_NOT_ENABLED",
    });

    expect(mocks.cfSshEnabled).not.toHaveBeenCalled();
    expect(mocks.cfEnableSsh).not.toHaveBeenCalled();
    expect(mocks.cfRestartApp).not.toHaveBeenCalled();
    expect(mocks.cfSshOneShot).toHaveBeenCalledTimes(1);
    expect(mocks.spawnSshTunnel).not.toHaveBeenCalled();
  });

  it("refuses to restart the app while targeting an explicit remote Node PID", async () => {
    mocks.cfSshOneShot.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "SSH support is disabled",
      outputTruncated: false,
    });

    await expect(startDebugger(withCredentials({ nodePid: 9876 }))).rejects.toMatchObject({
      code: "NODE_PID_RESTART_UNSAFE",
    });

    expect(mocks.cfSshOneShot).toHaveBeenCalledTimes(1);
    expect(mocks.cfSshEnabled).not.toHaveBeenCalled();
    expect(mocks.cfEnableSsh).not.toHaveBeenCalled();
    expect(mocks.cfRestartApp).not.toHaveBeenCalled();
    expect(mocks.spawnSshTunnel).not.toHaveBeenCalled();
    expect(mocks.removeSession).toHaveBeenCalledWith(session.sessionId);
  });

  it("aborts before opening a tunnel when a stop claim wins a status transition", async () => {
    mocks.updateSessionStatus.mockImplementation(
      async (_sessionId: string, status: SessionStatus, message?: string) => {
        session = message === undefined ? { ...session, status } : { ...session, status, message };
        return status === "tunneling" ? { ...session, status: "stopping" } : session;
      },
    );

    await expect(startDebugger(withCredentials())).rejects.toMatchObject({ code: "ABORTED" });

    expect(mocks.spawnSshTunnel).not.toHaveBeenCalled();
    expect(mocks.removeSession).toHaveBeenCalledWith(session.sessionId);
  });

  it("kills a spawned tunnel when the PID update observes a stop claim", async () => {
    mocks.updateSessionPid.mockResolvedValue({
      ...session,
      pid: 44_001,
      tunnelPid: 44_001,
      stopRequestedAt: "2026-01-01T00:00:01.000Z",
    });

    await withSuccessfulTunnelTermination(44_001, async (): Promise<void> => {
      await expect(startDebugger(withCredentials())).rejects.toMatchObject({ code: "ABORTED" });
    });
  });

  it("fails closed when ownership state disappears during the ready transition", async () => {
    mocks.updateSessionStatus.mockImplementation(
      async (_sessionId: string, status: SessionStatus, message?: string) => {
        session = message === undefined ? { ...session, status } : { ...session, status, message };
        return status === "ready" ? undefined : session;
      },
    );

    await withSuccessfulTunnelTermination(44_001, async (): Promise<void> => {
      await expect(startDebugger(withCredentials())).rejects.toMatchObject({
        code: "SESSION_STATE_LOST",
      });
      expect(mocks.removeSession).toHaveBeenCalledWith(session.sessionId);
    });
  });

  it("always finalizes the tunnel and CF home when recording the stopping status fails", async () => {
    const handle = await startDebugger(withCredentials());
    const statusError = new Error("state lock unavailable");
    mocks.updateSessionStatus.mockRejectedValueOnce(statusError);

    await expect(access(session.cfHomeDir)).resolves.toBeUndefined();
    await expect(handle.dispose()).rejects.toBe(statusError);

    expect(mocks.removeSession).toHaveBeenCalledWith(session.sessionId);
    await expect(access(session.cfHomeDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("always finalizes when a status observer throws while disposal starts", async () => {
    const observerError = new Error("status observer failed");
    const handle = await startDebugger(withCredentials({
      onStatus: (status) => {
        if (status === "stopping") {
          throw observerError;
        }
      },
    }));

    await expect(handle.dispose()).rejects.toBe(observerError);

    expect(mocks.removeSession).toHaveBeenCalledWith(session.sessionId);
    await expect(access(session.cfHomeDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries disposal after transient state removal failure", async () => {
    const handle = await startDebugger(withCredentials());
    const stateError = new Error("state removal failed");
    mocks.removeSession.mockRejectedValueOnce(stateError).mockResolvedValue(session);

    await expect(handle.dispose()).rejects.toBe(stateError);
    await expect(handle.dispose()).resolves.toBeUndefined();

    expect(mocks.removeSession).toHaveBeenCalledTimes(2);
    await expect(access(session.cfHomeDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("interrupts the post-signal wait as soon as the caller aborts", async () => {
    const controller = new AbortController();
    mocks.cfSshOneShot.mockImplementation(async () => {
      controller.abort();
      return {
        exitCode: 0,
        stdout: [
          "saptools-inspector-node-pid=4312",
          "saptools-inspector-owner-pid=4312",
          "saptools-inspector-ready",
        ].join("\n"),
        stderr: "",
        outputTruncated: false,
      };
    });
    const startedAt = Date.now();

    await expect(startDebugger(withCredentials({ signal: controller.signal }))).rejects.toMatchObject({
      code: "ABORTED",
    });

    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(mocks.spawnSshTunnel).not.toHaveBeenCalled();
  });

  it("cleans up and reports USR1 failures", async () => {
    mocks.cfSshOneShot.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "no node process",
      outputTruncated: false,
    });
    mocks.isSshDisabledError.mockReturnValue(false);

    await expect(startDebugger(withCredentials())).rejects.toMatchObject({
      code: "USR1_SIGNAL_FAILED",
    });
    expect(mocks.spawnSshTunnel).not.toHaveBeenCalled();
    expect(mocks.removeSession).toHaveBeenCalledWith("session-a");
  });

  it("fails closed on ambiguous remote Node processes before opening a tunnel", async () => {
    mocks.cfSshOneShot.mockResolvedValue({
      exitCode: 0,
      stdout: "saptools-inspector-node-ambiguous=11,22\n",
      stderr: "",
      outputTruncated: false,
    });

    await expect(startDebugger(withCredentials())).rejects.toMatchObject({
      code: "NODE_PROCESS_AMBIGUOUS",
    });
    expect(mocks.updateSessionRemoteNodePid).not.toHaveBeenCalled();
    expect(mocks.spawnSshTunnel).not.toHaveBeenCalled();
    expect(mocks.removeSession).toHaveBeenCalledWith("session-a");
  });

  it("reports a timed-out SIGUSR1 command with its five-minute limit", async () => {
    mocks.cfSshOneShot.mockResolvedValue({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOutAfterMs: 300_000,
      outputTruncated: false,
    });
    mocks.isSshDisabledError.mockReturnValue(false);

    await expect(startDebugger(withCredentials())).rejects.toMatchObject({
      code: "USR1_SIGNAL_FAILED",
      message: expect.stringContaining("timed out after 300s"),
    });
    expect(mocks.spawnSshTunnel).not.toHaveBeenCalled();
  });

  it("reports the signal that terminated the SIGUSR1 command", async () => {
    mocks.cfSshOneShot.mockResolvedValue({
      exitCode: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
      outputTruncated: false,
    });
    mocks.isSshDisabledError.mockReturnValue(false);

    await expect(startDebugger(withCredentials())).rejects.toMatchObject({
      code: "USR1_SIGNAL_FAILED",
      message: expect.stringContaining("terminated by signal SIGTERM"),
    });
  });

  it("cleans up when the tunnel never becomes ready", async () => {
    mocks.probeTunnelReady.mockResolvedValue(false);

    await withSuccessfulTunnelTermination(44_001, async (): Promise<void> => {
      await expect(
        startDebugger(withCredentials({ tunnelReadyTimeoutMs: 1 })),
      ).rejects.toMatchObject({
        code: "TUNNEL_NOT_READY",
      });
      expect(mocks.spawnSshTunnel).toHaveBeenCalled();
      expect(mocks.removeSession).toHaveBeenCalledWith("session-a");
    });
  });

  it("retains ownership evidence when startup cleanup cannot terminate the tunnel", async () => {
    let resolveProbe: ((ready: boolean) => void) | undefined;
    mocks.probeTunnelReady.mockImplementation(async () => await new Promise<boolean>((resolve) => {
      resolveProbe = resolve;
    }));
    mocks.isPidAlive.mockReturnValue(true);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const starting = startDebugger(withCredentials());
    await vi.waitFor(() => {
      expect(mocks.probeTunnelReady).toHaveBeenCalled();
    });
    vi.useFakeTimers();
    const rejection = expect(starting).rejects.toBeInstanceOf(AggregateError);

    try {
      if (resolveProbe === undefined) {
        throw new Error("Tunnel readiness probe was not captured");
      }
      resolveProbe(false);
      await vi.runAllTimersAsync();
      await rejection;
      expect(mocks.removeSession).not.toHaveBeenCalled();
      await expect(access(session.cfHomeDir)).resolves.toBeUndefined();
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it.runIf(process.platform !== "win32")(
    "retains ownership evidence while a tunnel process-group descendant remains alive",
    async () => {
      let resolveProbe: ((ready: boolean) => void) | undefined;
      mocks.probeTunnelReady.mockImplementation(async () => await new Promise<boolean>((resolve) => {
        resolveProbe = resolve;
      }));
      mocks.isPidAlive.mockImplementation((pid: number) => pid === -44_001);
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const starting = startDebugger(withCredentials());
      await vi.waitFor(() => {
        expect(mocks.probeTunnelReady).toHaveBeenCalled();
      });
      vi.useFakeTimers();
      const rejection = expect(starting).rejects.toBeInstanceOf(AggregateError);

      try {
        if (resolveProbe === undefined) {
          throw new Error("Tunnel readiness probe was not captured");
        }
        resolveProbe(false);
        await vi.runAllTimersAsync();
        await rejection;
        expect(mocks.removeSession).not.toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "terminates a surviving tunnel process group after its leader closes",
    async () => {
      let groupAlive = true;
      mocks.probeTunnelReady.mockImplementation(async () => {
        child.emit("close", 1);
        return false;
      });
      mocks.isPidAlive.mockImplementation((pid: number) => pid === -44_001 && groupAlive);
      mocks.isPortListening.mockImplementation(async () => groupAlive);
      const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -44_001 && signal === "SIGTERM") {
          groupAlive = false;
        }
        return true;
      });

      try {
        await expect(startDebugger(withCredentials())).rejects.toMatchObject({
          code: "TUNNEL_NOT_READY",
        });
        expect(killSpy).toHaveBeenCalledWith(-44_001, "SIGTERM");
        expect(mocks.removeSession).toHaveBeenCalledWith(session.sessionId);
      } finally {
        killSpy.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "never falls back to a reused PID after selecting a closed child's process group",
    async () => {
      let resolveProbe: ((ready: boolean) => void) | undefined;
      let groupChecks = 0;
      mocks.probeTunnelReady.mockImplementation(async () => await new Promise<boolean>((resolve) => {
        resolveProbe = resolve;
      }));
      mocks.isPidAlive.mockImplementation((pid: number) => {
        if (pid === -44_001) {
          groupChecks += 1;
          return groupChecks === 1;
        }
        return pid === 44_001;
      });
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const starting = startDebugger(withCredentials());
      await vi.waitFor(() => {
        expect(mocks.probeTunnelReady).toHaveBeenCalled();
      });
      Object.assign(child, { exitCode: 0 });
      child.emit("close", 0);
      vi.useFakeTimers();
      const failure = starting.catch((error: unknown): unknown => error);

      try {
        if (resolveProbe === undefined) {
          throw new Error("Tunnel readiness probe was not captured");
        }
        resolveProbe(false);
        await vi.runAllTimersAsync();
        expect(await failure).toMatchObject({ code: "TUNNEL_NOT_READY" });
        expect(killSpy).toHaveBeenCalledWith(-44_001, "SIGTERM");
        expect(killSpy).not.toHaveBeenCalledWith(44_001, "SIGTERM");
        expect(killSpy).not.toHaveBeenCalledWith(44_001, "SIGKILL");
        expect(mocks.removeSession).toHaveBeenCalledWith(session.sessionId);
        await expect(access(session.cfHomeDir)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        killSpy.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("fails closed without killing a process that takes the reserved port", async () => {
    mocks.isPortFree.mockResolvedValue(false);

    await expect(startDebugger(withCredentials())).rejects.toMatchObject({
      code: "PORT_UNAVAILABLE",
    });
    expect(mocks.spawnSshTunnel).not.toHaveBeenCalled();
  });

  it("rejects a tunnel listener owned by a process other than the spawned CF child", async () => {
    mocks.findListeningProcessId.mockResolvedValue(55_001);

    await expect(startDebugger(withCredentials())).rejects.toMatchObject({
      code: "TUNNEL_OWNER_MISMATCH",
    });
    expect(mocks.updateSessionPid).toHaveBeenCalledWith("session-a", 44_001);
  });

  it("retains ownership evidence when the tunnel child closes but its port stays open", async () => {
    mocks.findListeningProcessId.mockImplementation(async () => {
      child.emit("close", 1);
      return 55_001;
    });
    mocks.isPortListening.mockResolvedValue(true);
    const starting = startDebugger(withCredentials());

    await expect(starting).rejects.toBeInstanceOf(AggregateError);

    expect(mocks.removeSession).not.toHaveBeenCalled();
    await expect(access(session.cfHomeDir)).resolves.toBeUndefined();
  });

  it("aborts before creating a session when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(startDebugger(withCredentials({ signal: controller.signal }))).rejects.toMatchObject({
      code: "ABORTED",
    });
    expect(mocks.registerNewSession).not.toHaveBeenCalled();
  });

  it("does not spawn a tunnel when cancellation wins the final port check", async () => {
    const controller = new AbortController();
    mocks.isPortFree
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => {
        controller.abort();
        return true;
      });

    await expect(startDebugger(withCredentials({ signal: controller.signal }))).rejects.toMatchObject({
      code: "ABORTED",
    });
    expect(mocks.spawnSshTunnel).not.toHaveBeenCalled();
  });
});

describe("stopDebugger", () => {
  let tempDir: string;
  let session: ActiveSession;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cf-debugger-stop-"));
    session = createSession(tempDir, { pid: 77_001, status: "ready" });
    mocks.isPortListening.mockReset();
    mocks.findListeningProcessId.mockReset();
    mocks.isPidAlive.mockReset();
    mocks.readAndPruneActiveSessions.mockResolvedValue({ sessions: [session], removed: [] });
    mocks.readSessionSnapshot.mockImplementation(async () => [session]);
    mocks.isPortListening.mockResolvedValueOnce(true).mockResolvedValue(false);
    mocks.findListeningProcessId.mockResolvedValue(session.pid);
    mocks.isPidAlive.mockReturnValue(false);
    mocks.removeSession.mockResolvedValue(session);
    mocks.requestSessionStop.mockImplementation(async () => ({
      session: session.status === "ready"
        ? session
        : { ...session, stopRequestedAt: "2026-01-01T00:00:01.000Z" },
      previousStatus: session.status,
    }));
    mocks.sessionCfHomeDir.mockImplementation((id: string) => join(tempDir, id));
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns undefined when no session matches", async () => {
    mocks.readAndPruneActiveSessions.mockResolvedValue({ sessions: [], removed: [] });
    mocks.readSessionSnapshot.mockResolvedValue([]);

    await expect(stopDebugger({ sessionId: "missing" })).resolves.toBeUndefined();
    expect(mocks.removeSession).not.toHaveBeenCalled();
  });

  it("removes a matching session by key", async () => {
    vi.useFakeTimers();
    try {
      const removed = await stopDebugger({ key });
      await vi.runAllTimersAsync();

      expect(removed?.sessionId).toBe("session-a");
      expect(removed?.stale).toBe(false);
      expect(mocks.removeSession).toHaveBeenCalledWith("session-a");
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests cooperative cancellation without deleting a non-ready session", async () => {
    session = createSession(tempDir, {
      cfHomeDir: join(tempDir, "session-a"),
      pid: process.pid,
      status: "signaling",
    });
    await mkdir(session.cfHomeDir);
    mocks.readAndPruneActiveSessions.mockResolvedValue({ sessions: [session], removed: [] });
    mocks.requestSessionStop.mockResolvedValue({
      session: { ...session, stopRequestedAt: "2026-01-01T00:00:01.000Z" },
      previousStatus: "signaling",
    });
    mocks.isPidAlive.mockReturnValue(true);
    const killSpy = vi.spyOn(process, "kill");

    try {
      const stopped = await stopDebugger({ sessionId: session.sessionId });

      expect(stopped).toEqual(expect.objectContaining({
        status: "signaling",
        stopRequestedAt: "2026-01-01T00:00:01.000Z",
        stale: false,
        pending: true,
      }));
      expect(mocks.requestSessionStop).toHaveBeenCalledWith(session.sessionId);
      expect(mocks.removeSession).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
      await expect(access(session.cfHomeDir)).resolves.toBeUndefined();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("removes a completed stopping record even while its controller remains alive", async () => {
    session = createSession(tempDir, {
      controllerPid: process.pid,
      pid: 77_001,
      tunnelPid: 77_001,
      status: "stopping",
    });
    mocks.readSessionSnapshot.mockImplementation(async () => [session]);
    mocks.requestSessionStop.mockResolvedValue({
      session: { ...session, stopRequestedAt: "2026-01-01T00:00:01.000Z" },
      previousStatus: "stopping",
    });
    mocks.isPidAlive.mockImplementation((pid: number) => pid === process.pid);
    mocks.isPortListening.mockReset().mockResolvedValue(false);

    const stopped = await stopDebugger({ sessionId: session.sessionId });

    expect(stopped).toEqual(expect.objectContaining({ pending: false, stale: true }));
    expect(mocks.removeSession).toHaveBeenCalledWith(session.sessionId);
  });

  it("does not signal a PID that no longer owns the recorded tunnel port", async () => {
    mocks.isPortListening.mockResolvedValue(true);
    mocks.findListeningProcessId.mockResolvedValue(88_002);
    const killSpy = vi.spyOn(process, "kill");
    try {
      await expect(stopDebugger({ sessionId: session.sessionId })).rejects.toMatchObject({
        code: "TUNNEL_OWNERSHIP_UNVERIFIED",
      });

      expect(killSpy).not.toHaveBeenCalled();
      expect(mocks.removeSession).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("retains ready-session evidence when the verified tunnel does not terminate", async () => {
    vi.useFakeTimers();
    mocks.isPortListening.mockReset().mockResolvedValue(true);
    mocks.findListeningProcessId.mockResolvedValue(session.tunnelPid);
    mocks.isPidAlive.mockImplementation((pid: number) => pid === session.tunnelPid);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      const stopping = stopDebugger({ sessionId: session.sessionId });
      const rejection = expect(stopping).rejects.toMatchObject({
        code: "TUNNEL_TERMINATION_FAILED",
      });
      await vi.runAllTimersAsync();
      await rejection;
      expect(mocks.removeSession).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retains startup evidence when an orphan tunnel does not terminate", async () => {
    vi.useFakeTimers();
    session = createSession(tempDir, {
      pid: 77_001,
      tunnelPid: 77_001,
      controllerPid: 77_002,
      status: "tunneling",
    });
    mocks.readSessionSnapshot.mockImplementation(async () => [session]);
    mocks.requestSessionStop.mockResolvedValue({
      session: { ...session, stopRequestedAt: "2026-01-01T00:00:01.000Z" },
      previousStatus: "tunneling",
    });
    mocks.isPortListening.mockReset().mockResolvedValue(true);
    mocks.findListeningProcessId.mockResolvedValue(session.tunnelPid);
    mocks.isPidAlive.mockImplementation((pid: number) => pid === session.tunnelPid);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      const stopping = stopDebugger({ sessionId: session.sessionId });
      const rejection = expect(stopping).rejects.toMatchObject({
        code: "TUNNEL_TERMINATION_FAILED",
      });
      await vi.runAllTimersAsync();
      await rejection;
      expect(mocks.removeSession).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not delete an unowned directory from an active state record", async () => {
    await mkdir(session.cfHomeDir);

    await stopDebugger({ sessionId: session.sessionId });

    await expect(access(session.cfHomeDir)).resolves.toBeUndefined();
  });

  it("does not delete an unowned directory from a stale state record", async () => {
    await mkdir(session.cfHomeDir);
    mocks.isPortListening.mockReset().mockResolvedValue(false);

    await stopDebugger({ sessionId: session.sessionId });

    await expect(access(session.cfHomeDir)).resolves.toBeUndefined();
  });

  it("deletes the canonical per-session CF home", async () => {
    session = { ...session, cfHomeDir: join(tempDir, session.sessionId) };
    await mkdir(session.cfHomeDir);
    mocks.readAndPruneActiveSessions.mockResolvedValue({ sessions: [session], removed: [] });

    await stopDebugger({ sessionId: session.sessionId });

    await expect(access(session.cfHomeDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a provably stale session by session id", async () => {
    mocks.isPortListening.mockReset().mockResolvedValue(false);

    const removed = await stopDebugger({ sessionId: "session-a" });

    expect(removed?.sessionId).toBe("session-a");
    expect(removed?.stale).toBe(true);
    expect(mocks.removeSession).toHaveBeenCalledWith(session.sessionId);
  });

  it("removes a provably stale session by key", async () => {
    mocks.isPortListening.mockReset().mockResolvedValue(false);

    const removed = await stopDebugger({ key });

    expect(removed?.sessionId).toBe("session-a");
    expect(removed?.stale).toBe(true);
  });

  it("fails closed when a partial key matches multiple exact remote targets", async () => {
    const other = createSession(tempDir, {
      sessionId: "session-b",
      pid: 77_002,
      apiEndpoint: "https://api-other.example.com",
      nodePid: 9876,
    });
    mocks.readAndPruneActiveSessions.mockResolvedValue({ sessions: [session, other], removed: [] });
    mocks.readSessionSnapshot.mockResolvedValue([session, other]);

    await expect(stopDebugger({ key })).rejects.toMatchObject({ code: "SESSION_AMBIGUOUS" });
    expect(mocks.removeSession).not.toHaveBeenCalled();
  });
});

describe("session readers", () => {
  let tempDir: string;
  let session: ActiveSession;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cf-debugger-readers-"));
    session = createSession(tempDir, { pid: 77_001, status: "ready" });
    mocks.readActiveSessions.mockResolvedValue([]);
    mocks.readAndPruneActiveSessions.mockResolvedValue({ sessions: [], removed: [session] });
    mocks.readSessionSnapshot.mockResolvedValue([session]);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("lists healthy active sessions through the pruned state view", async () => {
    mocks.readActiveSessions.mockResolvedValue([session]);

    await expect(listSessions()).resolves.toEqual([session]);

    expect(mocks.readActiveSessions).toHaveBeenCalledTimes(1);
    expect(mocks.readSessionSnapshot).not.toHaveBeenCalled();
  });

  it("gets a session through the same pruned state view as list", async () => {
    mocks.readActiveSessions.mockResolvedValue([session]);

    await expect(getSession(key)).resolves.toEqual(session);

    expect(mocks.readActiveSessions).toHaveBeenCalledTimes(1);
    expect(mocks.readSessionSnapshot).not.toHaveBeenCalled();
  });

  it("fails closed when status lookup matches multiple exact remote targets", async () => {
    const other = createSession(tempDir, {
      sessionId: "session-b",
      apiEndpoint: "https://api-other.example.com",
      nodePid: 9876,
    });
    mocks.readActiveSessions.mockResolvedValue([session, other]);

    await expect(getSession(key)).rejects.toMatchObject({ code: "SESSION_AMBIGUOUS" });
  });
});
