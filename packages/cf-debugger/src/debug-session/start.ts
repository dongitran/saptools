import type { ChildProcess } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import process from "node:process";

import type { CfExecContext } from "../cf.js";
import {
  cfEnableSsh,
  cfLogin,
  cfRestartApp,
  cfSshEnabled,
  cfSshOneShot,
  cfTarget,
  isSshDisabledError,
  spawnSshTunnel,
} from "../cf.js";
import { sessionCfHomeDir } from "../paths.js";
import { findListeningProcessId, isPortFree, killProcessOnPort, probeTunnelReady } from "../port.js";
import { resolveApiEndpoint } from "../regions.js";
import {
  registerNewSession,
  removeSession,
  sessionKeyString,
  updateSessionPid,
  updateSessionStatus,
} from "../state.js";
import type { ActiveSession, DebuggerHandle, SessionStatus, StartDebuggerOptions } from "../types.js";
import { CfDebuggerError } from "../types.js";

import {
  DEFAULT_TUNNEL_READY_TIMEOUT_MS,
  PORT_CLEANUP_DELAY_MS,
  PORT_RECLAIM_DELAY_MS,
  POST_USR1_DELAY_MS,
} from "./constants.js";
import { pruneAndCleanupOrphans } from "./orphans.js";
import { killProcessGroupOrProc } from "./processes.js";

type StatusEmitter = (status: SessionStatus, message?: string) => void;

interface TunnelResult {
  readonly child: ChildProcess;
  readonly activePid: number;
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

async function registerSession(
  options: StartDebuggerOptions,
  apiEndpoint: string,
): Promise<ActiveSession> {
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
  return registration.session;
}

async function loginAndTarget(
  options: StartDebuggerOptions,
  apiEndpoint: string,
  email: string,
  password: string,
  context: CfExecContext,
  sessionId: string,
  emit: StatusEmitter,
): Promise<void> {
  emit("logging-in");
  await updateSessionStatus(sessionId, "logging-in");
  await cfLogin(apiEndpoint, email, password, context);
  checkAbort(options.signal);

  emit("targeting");
  await updateSessionStatus(sessionId, "targeting");
  await cfTarget(options.org, options.space, context);
  checkAbort(options.signal);
}

async function signalRemoteNode(
  options: StartDebuggerOptions,
  context: CfExecContext,
  sessionId: string,
  emit: StatusEmitter,
): Promise<void> {
  emit("signaling");
  await updateSessionStatus(sessionId, "signaling");
  const signalResult = await cfSshOneShot(options.app, `kill -s USR1 $(pidof node)`, context);

  if (!isSshDisabledError(signalResult.stderr)) {
    if (signalResult.exitCode === 0) {
      return;
    }
    const detail = signalResult.stderr.trim().length > 0
      ? signalResult.stderr.trim()
      : `exit code ${String(signalResult.exitCode)}`;
    throw new CfDebuggerError(
      "USR1_SIGNAL_FAILED",
      `Failed to send SIGUSR1 to the Node.js process on ${options.app}: ${detail}`,
      signalResult.stderr,
    );
  }

  const alreadyEnabled = await cfSshEnabled(options.app, context);
  if (!alreadyEnabled) {
    emit("ssh-enabling", "Enabling SSH on the app");
    await updateSessionStatus(sessionId, "ssh-enabling");
    await cfEnableSsh(options.app, context);
  }
  emit("ssh-restarting", "Restarting app so SSH becomes active");
  await updateSessionStatus(sessionId, "ssh-restarting");
  await cfRestartApp(options.app, context);
  checkAbort(options.signal);

  await retryRemoteSignal(options, context, sessionId, emit);
}

async function retryRemoteSignal(
  options: StartDebuggerOptions,
  context: CfExecContext,
  sessionId: string,
  emit: StatusEmitter,
): Promise<void> {
  emit("signaling");
  await updateSessionStatus(sessionId, "signaling");
  const retrySignalResult = await cfSshOneShot(
    options.app,
    `kill -s USR1 $(pidof node)`,
    context,
  );
  if (retrySignalResult.exitCode === 0) {
    return;
  }
  const detail = retrySignalResult.stderr.trim().length > 0
    ? retrySignalResult.stderr.trim()
    : `exit code ${String(retrySignalResult.exitCode)}`;
  throw new CfDebuggerError(
    "USR1_SIGNAL_FAILED",
    `Failed to send SIGUSR1 to the Node.js process on ${options.app} after enabling SSH: ${detail}`,
    retrySignalResult.stderr,
  );
}

async function waitAfterSignal(signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, POST_USR1_DELAY_MS);
  });
  checkAbort(signal);
}

async function ensurePortAvailable(localPort: number): Promise<void> {
  if (await isPortFree(localPort)) {
    return;
  }
  await killProcessOnPort(localPort);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, PORT_RECLAIM_DELAY_MS);
  });
  if (!(await isPortFree(localPort))) {
    throw new CfDebuggerError(
      "PORT_UNAVAILABLE",
      `Local port ${localPort.toString()} is in use and could not be reclaimed for the tunnel.`,
    );
  }
}

async function openReadyTunnel(
  options: StartDebuggerOptions,
  session: ActiveSession,
  context: CfExecContext,
  tunnelReadyTimeoutMs: number,
  onChild: (child: ChildProcess) => void,
): Promise<TunnelResult> {
  await ensurePortAvailable(session.localPort);
  const child = spawnSshTunnel(options.app, session.localPort, session.remotePort, context);
  onChild(child);
  if (child.pid !== undefined) {
    await updateSessionPid(session.sessionId, child.pid);
  }

  const ready = await probeTunnelReady(session.localPort, tunnelReadyTimeoutMs);
  checkAbort(options.signal);
  if (!ready) {
    throw new CfDebuggerError(
      "TUNNEL_NOT_READY",
      `SSH tunnel on port ${session.localPort.toString()} did not become ready within ` +
        `${Math.round(tunnelReadyTimeoutMs / 1000).toString()}s.`,
    );
  }

  const listeningPid = await findListeningProcessId(session.localPort);
  const activePid = listeningPid ?? child.pid ?? session.pid;
  if (activePid !== session.pid) {
    await updateSessionPid(session.sessionId, activePid);
  }
  return { child, activePid };
}

function attachTunnelEvents(
  child: ChildProcess,
  markClosed: () => void,
  resolveExit: (code: number | null) => void,
  emit: StatusEmitter,
): void {
  child.on("close", (code) => {
    markClosed();
    resolveExit(code);
  });

  child.on("error", (err: Error) => {
    emit("error", err.message);
  });
}

function createHandle(
  session: ActiveSession,
  emit: StatusEmitter,
  finalize: () => Promise<void>,
  exitPromise: Promise<number | null>,
): DebuggerHandle {
  let disposePromise: Promise<void> | undefined;
  return {
    session,
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

  const session = await registerSession(options, apiEndpoint);
  const context: CfExecContext = { cfHome: session.cfHomeDir };
  let child: ChildProcess | undefined;
  let tunnelClosed = false;
  let exitResolve: (code: number | null) => void = (_code) => {
    throw new Error("Exit resolver was used before initialization");
  };
  const exitPromise = new Promise<number | null>((resolve) => {
    exitResolve = resolve;
  });

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
    await cleanupFilesystem(session.cfHomeDir);
    emit("stopped");
  };

  try {
    await mkdir(session.cfHomeDir, { recursive: true });
    await loginAndTarget(options, apiEndpoint, email, password, context, session.sessionId, emit);
    await killProcessOnPort(session.localPort);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });
    await signalRemoteNode(options, context, session.sessionId, emit);
    await waitAfterSignal(options.signal);

    emit("tunneling");
    await updateSessionStatus(session.sessionId, "tunneling");
    const tunnel = await openReadyTunnel(
      options,
      session,
      context,
      tunnelReadyTimeoutMs,
      (tunnelChild) => {
        child = tunnelChild;
        attachTunnelEvents(tunnelChild, () => {
          tunnelClosed = true;
        }, exitResolve, emit);
      },
    );
    child = tunnel.child;

    emit("ready");
    const readySession = await updateSessionStatus(session.sessionId, "ready");
    const activeSession = readySession ?? { ...session, pid: tunnel.activePid, status: "ready" };
    return createHandle(activeSession, emit, finalize, exitPromise);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    emit("error", message);
    await finalize();
    throw err;
  }
}

async function cleanupFilesystem(cfHomeDir: string): Promise<void> {
  try {
    await rm(cfHomeDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
