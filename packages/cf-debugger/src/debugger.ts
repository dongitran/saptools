import type { ChildProcess } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { hostname as getHostname } from "node:os";
import process from "node:process";

import type { CfExecContext } from "./cf.js";
import {
  cfEnableSsh,
  cfLogin,
  cfRestartApp,
  cfSshEnabled,
  cfSshOneShot,
  cfTarget,
  isSshDisabledError,
  spawnSshTunnel,
} from "./cf.js";
import { sessionCfHomeDir } from "./paths.js";
import { isPortFree, killProcessOnPort, probeTunnelReady } from "./port.js";
import { resolveApiEndpoint } from "./regions.js";
import {
  matchesKey,
  readAndPruneActiveSessions,
  registerNewSession,
  removeSession,
  sessionKeyString,
  updateSessionStatus,
} from "./state.js";
import type {
  ActiveSession,
  DebuggerHandle,
  SessionKey,
  SessionStatus,
  StartDebuggerOptions,
} from "./types.js";
import { CfDebuggerError } from "./types.js";

const DEFAULT_TUNNEL_READY_TIMEOUT_MS = 30_000;
const POST_USR1_DELAY_MS = 300;
const PORT_CLEANUP_DELAY_MS = 600;
const CHILD_SIGTERM_GRACE_MS = 2_000;
const PORT_RECLAIM_DELAY_MS = 250;

async function killProcessGroupOrProc(
  child: ChildProcess,
  timeoutMs: number = CHILD_SIGTERM_GRACE_MS,
): Promise<void> {
  if (child.pid === undefined) {
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const isWindows = process.platform === "win32";
  const send = (sig: NodeJS.Signals): void => {
    try {
      if (!isWindows && child.pid !== undefined) {
        process.kill(-child.pid, sig);
      } else {
        child.kill(sig);
      }
    } catch {
      // already gone
    }
  };
  send("SIGTERM");
  const closed = await new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const t = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    child.once("close", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  if (!closed) {
    send("SIGKILL");
  }
}

async function pruneAndCleanupOrphans(): Promise<readonly ActiveSession[]> {
  const result = await readAndPruneActiveSessions();
  const host = getHostname();
  for (const removed of result.removed) {
    if (removed.hostname === host) {
      void killProcessOnPort(removed.localPort);
    }
  }
  return result.sessions;
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CfDebuggerError("ABORTED", "Operation aborted by caller");
  }
}

function requireCredentials(options: StartDebuggerOptions): {
  readonly email: string;
  readonly password: string;
} {
  const email = options.email ?? process.env["SAP_EMAIL"];
  const password = options.password ?? process.env["SAP_PASSWORD"];
  if (email === undefined || email === "") {
    throw new CfDebuggerError(
      "MISSING_CREDENTIALS",
      "SAP email is required. Pass `email` or set SAP_EMAIL env var.",
    );
  }
  if (password === undefined || password === "") {
    throw new CfDebuggerError(
      "MISSING_CREDENTIALS",
      "SAP password is required. Pass `password` or set SAP_PASSWORD env var.",
    );
  }
  return { email, password };
}

export async function startDebugger(options: StartDebuggerOptions): Promise<DebuggerHandle> {
  const { email, password } = requireCredentials(options);
  const apiEndpoint = resolveApiEndpoint(options.region, options.apiEndpoint);
  const tunnelReadyTimeoutMs = options.tunnelReadyTimeoutMs ?? DEFAULT_TUNNEL_READY_TIMEOUT_MS;
  const emit = (status: SessionStatus, message?: string): void => {
    options.onStatus?.(status, message);
  };

  checkAbort(options.signal);

  await pruneAndCleanupOrphans();

  const registration = await registerNewSession({
    region: options.region,
    org: options.org,
    space: options.space,
    app: options.app,
    apiEndpoint,
    ...(options.preferredPort === undefined ? {} : { preferredPort: options.preferredPort }),
    portProbe: isPortFree,
    cfHomeForSession: sessionCfHomeDir,
  });

  if (registration.existing) {
    throw new CfDebuggerError(
      "SESSION_ALREADY_RUNNING",
      `A debugger session is already running for ${sessionKeyString(options)} ` +
        `on port ${registration.existing.localPort.toString()} ` +
        `(pid ${registration.existing.pid.toString()}, sessionId ${registration.existing.sessionId}). ` +
        `Stop it first with \`cf-debugger stop\`.`,
    );
  }

  const session = registration.session;
  const context: CfExecContext = { cfHome: session.cfHomeDir };

  let child: ChildProcess | undefined;
  let tunnelClosed = false;
  let exitResolve: ((code: number | null) => void) | undefined;
  const exitPromise = new Promise<number | null>((resolve) => {
    exitResolve = resolve;
  });

  const cleanupFilesystem = async (): Promise<void> => {
    try {
      await rm(session.cfHomeDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };

  const finalize = async (): Promise<void> => {
    if (!tunnelClosed) {
      tunnelClosed = true;
      if (child) {
        await killProcessGroupOrProc(child);
      }
      setTimeout(() => {
        void killProcessOnPort(session.localPort);
      }, PORT_CLEANUP_DELAY_MS);
    }
    await removeSession(session.sessionId);
    await cleanupFilesystem();
    emit("stopped");
  };

  try {
    await mkdir(session.cfHomeDir, { recursive: true });

    emit("logging-in");
    await updateSessionStatus(session.sessionId, "logging-in");
    await cfLogin(apiEndpoint, email, password, context);
    checkAbort(options.signal);

    emit("targeting");
    await updateSessionStatus(session.sessionId, "targeting");
    await cfTarget(options.org, options.space, context);
    checkAbort(options.signal);

    await killProcessOnPort(session.localPort);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });

    emit("signaling");
    await updateSessionStatus(session.sessionId, "signaling");
    const signalResult = await cfSshOneShot(
      options.app,
      `kill -s USR1 $(pidof node)`,
      context,
    );

    if (isSshDisabledError(signalResult.stderr)) {
      const alreadyEnabled = await cfSshEnabled(options.app, context);
      if (!alreadyEnabled) {
        emit("ssh-enabling", "Enabling SSH on the app");
        await updateSessionStatus(session.sessionId, "ssh-enabling");
        await cfEnableSsh(options.app, context);
      }
      emit("ssh-restarting", "Restarting app so SSH becomes active");
      await updateSessionStatus(session.sessionId, "ssh-restarting");
      await cfRestartApp(options.app, context);
      checkAbort(options.signal);

      emit("signaling");
      await updateSessionStatus(session.sessionId, "signaling");
      const retrySignalResult = await cfSshOneShot(
        options.app,
        `kill -s USR1 $(pidof node)`,
        context,
      );
      if (retrySignalResult.exitCode !== 0) {
        const detail =
          retrySignalResult.stderr.trim().length > 0
            ? retrySignalResult.stderr.trim()
            : `exit code ${String(retrySignalResult.exitCode)}`;
        throw new CfDebuggerError(
          "USR1_SIGNAL_FAILED",
          `Failed to send SIGUSR1 to the Node.js process on ${options.app} after enabling SSH: ${detail}`,
          retrySignalResult.stderr,
        );
      }
    } else if (signalResult.exitCode !== 0) {
      const detail =
        signalResult.stderr.trim().length > 0
          ? signalResult.stderr.trim()
          : `exit code ${String(signalResult.exitCode)}`;
      throw new CfDebuggerError(
        "USR1_SIGNAL_FAILED",
        `Failed to send SIGUSR1 to the Node.js process on ${options.app}: ${detail}`,
        signalResult.stderr,
      );
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, POST_USR1_DELAY_MS);
    });
    checkAbort(options.signal);

    emit("tunneling");
    await updateSessionStatus(session.sessionId, "tunneling");

    if (!(await isPortFree(session.localPort))) {
      await killProcessOnPort(session.localPort);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, PORT_RECLAIM_DELAY_MS);
      });
      if (!(await isPortFree(session.localPort))) {
        throw new CfDebuggerError(
          "PORT_UNAVAILABLE",
          `Local port ${session.localPort.toString()} is in use and could not be reclaimed for the tunnel.`,
        );
      }
    }

    child = spawnSshTunnel(options.app, session.localPort, session.remotePort, context);

    child.on("close", (code) => {
      tunnelClosed = true;
      exitResolve?.(code);
    });

    child.on("error", (err: Error) => {
      emit("error", err.message);
    });

    const ready = await probeTunnelReady(session.localPort, tunnelReadyTimeoutMs);
    checkAbort(options.signal);
    if (!ready) {
      throw new CfDebuggerError(
        "TUNNEL_NOT_READY",
        `SSH tunnel on port ${session.localPort.toString()} did not become ready within ` +
          `${Math.round(tunnelReadyTimeoutMs / 1000).toString()}s.`,
      );
    }

    emit("ready");
    const readySession = await updateSessionStatus(session.sessionId, "ready");
    const activeSession: ActiveSession = readySession ?? { ...session, status: "ready" };

    let disposePromise: Promise<void> | undefined;
    const handle: DebuggerHandle = {
      session: activeSession,
      dispose: async (): Promise<void> => {
        disposePromise ??= (async (): Promise<void> => {
          emit("stopping");
          await updateSessionStatus(session.sessionId, "stopping");
          await finalize();
        })();
        await disposePromise;
      },
      waitForExit: async (): Promise<number | null> => {
        return await exitPromise;
      },
    };

    return handle;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    emit("error", message);
    await finalize();
    throw err;
  }
}

export interface StopOptions {
  readonly sessionId?: string;
  readonly key?: SessionKey;
}

export async function stopDebugger(options: StopOptions): Promise<ActiveSession | undefined> {
  const sessions = await pruneAndCleanupOrphans();
  let target: ActiveSession | undefined;
  if (options.sessionId !== undefined) {
    target = sessions.find((s) => s.sessionId === options.sessionId);
  } else if (options.key !== undefined) {
    const key = options.key;
    target = sessions.find((s) => matchesKey(s, key));
  }
  if (target === undefined) {
    return undefined;
  }
  if (target.pid !== process.pid) {
    try {
      process.kill(target.pid, "SIGTERM");
    } catch {
      // process already gone — cleanup below
    }
  }
  setTimeout(() => {
    void killProcessOnPort(target.localPort);
  }, PORT_CLEANUP_DELAY_MS);
  const removed = await removeSession(target.sessionId);
  try {
    await rm(target.cfHomeDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  return removed;
}

export async function stopAllDebuggers(): Promise<number> {
  const sessions = await pruneAndCleanupOrphans();
  let stopped = 0;
  for (const session of sessions) {
    const result = await stopDebugger({ sessionId: session.sessionId });
    if (result) {
      stopped += 1;
    }
  }
  return stopped;
}

export async function listSessions(): Promise<readonly ActiveSession[]> {
  return await pruneAndCleanupOrphans();
}

export async function getSession(key: SessionKey): Promise<ActiveSession | undefined> {
  const sessions = await pruneAndCleanupOrphans();
  return sessions.find((s) => matchesKey(s, key));
}
