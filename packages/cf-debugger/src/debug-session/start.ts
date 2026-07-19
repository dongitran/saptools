import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";
import process from "node:process";

import {
  cfEnableSsh,
  cfLogin,
  cfRestartApp,
  cfSshEnabled,
  cfSshOneShot,
  cfTarget,
  isSshDisabledError,
  spawnSshTunnel,
  type CfExecContext,
} from "../cf.js";
import {
  buildNodeInspectorCommand,
  parseNodeInspectorMarkers,
  resolveNodeTarget,
  type ResolvedNodeTarget,
} from "../cloud-foundry/node-process.js";
import { sessionCfHomeDir } from "../paths.js";
import {
  findListeningProcessId,
  isPortFree,
  isPortListening,
  probeTunnelReady,
} from "../port.js";
import { resolveApiEndpoint } from "../regions.js";
import {
  registerNewSession,
  removeSession,
  sessionKeyString,
  updateSessionPid,
  updateSessionRemoteNodePid,
  updateSessionStatus,
} from "../state.js";
import type { ActiveSession, DebuggerHandle, SessionStatus, StartDebuggerOptions } from "../types.js";
import { CfDebuggerError } from "../types.js";

import {
  DEFAULT_TUNNEL_READY_TIMEOUT_MS,
  POST_USR1_DELAY_MS,
} from "./constants.js";
import { pruneAndCleanupOrphans } from "./orphans.js";
import { killProcessGroupOrProc } from "./processes.js";
import { createStartupCancellation } from "./startup-cancellation.js";

type StatusEmitter = (status: SessionStatus, message?: string) => void;

interface TunnelLifecycle {
  readonly exitPromise: Promise<number | null>;
  readonly finalize: () => Promise<void>;
  readonly observeChild: (child: ChildProcess) => void;
}

interface StartupInputs {
  readonly options: StartDebuggerOptions;
  readonly target: ResolvedNodeTarget;
  readonly session: ActiveSession;
  readonly context: CfExecContext;
  readonly credentials: { readonly email: string; readonly password: string };
  readonly timeoutMs: number;
  readonly lifecycle: TunnelLifecycle;
  readonly emit: StatusEmitter;
}

type SignalResult = Awaited<ReturnType<typeof cfSshOneShot>>;

function signalFailureDetail(result: SignalResult): string {
  if (result.timedOutAfterMs !== undefined) {
    return `timed out after ${(result.timedOutAfterMs / 1000).toString()}s`;
  }
  const stderr = result.stderr.trim();
  if (stderr.length > 0) {
    return stderr;
  }
  if (result.signal !== undefined) {
    return `terminated by signal ${result.signal}`;
  }
  return `exit code ${String(result.exitCode)}`;
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CfDebuggerError("ABORTED", "Operation aborted by caller");
  }
}

function requireStartupState(
  state: ActiveSession | undefined,
  expectedStatus?: SessionStatus,
): ActiveSession {
  if (state === undefined) {
    throw new CfDebuggerError(
      "SESSION_STATE_LOST",
      "Debugger session ownership state disappeared during startup.",
    );
  }
  if (state.stopRequestedAt !== undefined || state.status === "stopping") {
    throw new CfDebuggerError("ABORTED", "Debugger session stop was requested during startup.");
  }
  if (expectedStatus !== undefined && state.status !== expectedStatus) {
    throw new CfDebuggerError(
      "SESSION_STATE_CONFLICT",
      `Debugger session state did not transition to ${expectedStatus}.`,
    );
  }
  return state;
}

async function transitionStartupStatus(
  sessionId: string,
  status: SessionStatus,
  message?: string,
): Promise<ActiveSession> {
  return requireStartupState(await updateSessionStatus(sessionId, status, message), status);
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
  target: ResolvedNodeTarget,
  apiEndpoint: string,
): Promise<ActiveSession> {
  const registration = await registerNewSession({
    region: options.region,
    org: options.org,
    space: options.space,
    app: options.app,
    process: target.process,
    instance: target.instance,
    ...(target.nodePid === undefined ? {} : { nodePid: target.nodePid }),
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
  await transitionStartupStatus(sessionId, "logging-in");
  await cfLogin(apiEndpoint, email, password, context);
  checkAbort(context.signal);

  emit("targeting");
  await transitionStartupStatus(sessionId, "targeting");
  await cfTarget(options.org, options.space, context);
  checkAbort(context.signal);
}

async function signalRemoteNode(
  options: StartDebuggerOptions,
  target: ResolvedNodeTarget,
  context: CfExecContext,
  sessionId: string,
  emit: StatusEmitter,
): Promise<number> {
  emit("signaling");
  await transitionStartupStatus(sessionId, "signaling");
  const signalResult = await executeRemoteSignal(options.app, target, context);

  if (!isSshDisabledError(signalResult.stderr)) {
    return parseSignalResult(options.app, signalResult);
  }

  if (options.allowSshEnableRestart === false) {
    throw new CfDebuggerError(
      "SSH_NOT_ENABLED",
      `SSH is disabled for ${options.app}; automatic SSH enable and app restart are not allowed.`,
      signalResult.stderr,
    );
  }
  await enableSshAndRestart(options, target, context, sessionId, emit);
  return await retryRemoteSignal(options, target, context, sessionId, emit);
}

async function enableSshAndRestart(
  options: StartDebuggerOptions,
  target: ResolvedNodeTarget,
  context: CfExecContext,
  sessionId: string,
  emit: StatusEmitter,
): Promise<void> {
  if (target.nodePid !== undefined) {
    throw new CfDebuggerError(
      "NODE_PID_RESTART_UNSAFE",
      `Cannot automatically restart ${options.app} while targeting remote Node PID ` +
        `${target.nodePid.toString()}. Enable SSH and restart the app first, then retry with its new PID.`,
    );
  }

  const alreadyEnabled = await cfSshEnabled(options.app, context);
  if (!alreadyEnabled) {
    emit("ssh-enabling", "Enabling SSH on the app");
    await transitionStartupStatus(sessionId, "ssh-enabling");
    await cfEnableSsh(options.app, context);
  }
  emit("ssh-restarting", "Restarting app so SSH becomes active");
  await transitionStartupStatus(sessionId, "ssh-restarting");
  await cfRestartApp(options.app, context);
  checkAbort(context.signal);
}

async function retryRemoteSignal(
  options: StartDebuggerOptions,
  target: ResolvedNodeTarget,
  context: CfExecContext,
  sessionId: string,
  emit: StatusEmitter,
): Promise<number> {
  emit("signaling");
  await transitionStartupStatus(sessionId, "signaling");
  const retrySignalResult = await executeRemoteSignal(options.app, target, context);
  if (retrySignalResult.exitCode === 0) {
    return parseSignalResult(options.app, retrySignalResult);
  }
  throw new CfDebuggerError(
    "USR1_SIGNAL_FAILED",
    `Failed to send SIGUSR1 to the Node.js process on ${options.app} after enabling SSH: ${
      signalFailureDetail(retrySignalResult)
    }`,
    retrySignalResult.stderr,
  );
}

async function executeRemoteSignal(
  appName: string,
  target: ResolvedNodeTarget,
  context: CfExecContext,
): Promise<SignalResult> {
  return await cfSshOneShot(appName, buildNodeInspectorCommand(target.nodePid), context, {
    process: target.process,
    instance: target.instance,
  });
}

function parseSignalResult(appName: string, result: SignalResult): number {
  if (result.exitCode !== 0) {
    throw new CfDebuggerError(
      "USR1_SIGNAL_FAILED",
      `Failed to send SIGUSR1 to the Node.js process on ${appName}: ${signalFailureDetail(result)}`,
      result.stderr,
    );
  }
  if (result.outputTruncated) {
    throw new CfDebuggerError(
      "INSPECTOR_OUTPUT_TOO_LARGE",
      "Inspector startup output exceeded the configured capture limit.",
    );
  }
  return parseNodeInspectorMarkers(result.stdout).remoteNodePid;
}

async function waitAfterSignal(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    throw new CfDebuggerError("ABORTED", "Operation aborted by caller");
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CfDebuggerError("ABORTED", "Operation aborted by caller"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, POST_USR1_DELAY_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function ensurePortAvailable(localPort: number): Promise<void> {
  if (!(await isPortFree(localPort))) {
    throw new CfDebuggerError(
      "PORT_UNAVAILABLE",
      `Local port ${localPort.toString()} was taken before the tunnel could start.`,
    );
  }
}

async function openReadyTunnel(
  options: StartDebuggerOptions,
  target: ResolvedNodeTarget,
  session: ActiveSession,
  context: CfExecContext,
  tunnelReadyTimeoutMs: number,
  onChild: (child: ChildProcess) => void,
): Promise<void> {
  await ensurePortAvailable(session.localPort);
  checkAbort(context.signal);
  const child = spawnSshTunnel(options.app, session.localPort, session.remotePort, context, {
    process: target.process,
    instance: target.instance,
  });
  onChild(child);
  const childPid = child.pid;
  if (childPid === undefined) {
    throw new CfDebuggerError("TUNNEL_PROCESS_MISSING", "The CF SSH tunnel process did not expose a PID.");
  }
  const pidState = requireStartupState(await updateSessionPid(session.sessionId, childPid));
  if (pidState.tunnelPid !== childPid || pidState.pid !== childPid) {
    throw new CfDebuggerError(
      "SESSION_STATE_CONFLICT",
      "Debugger session did not retain ownership of the spawned tunnel process.",
    );
  }

  const ready = await probeTunnelReady(
    session.localPort,
    tunnelReadyTimeoutMs,
    context.signal,
  );
  checkAbort(context.signal);
  if (!ready) {
    throw new CfDebuggerError(
      "TUNNEL_NOT_READY",
      `SSH tunnel on port ${session.localPort.toString()} did not become ready within ` +
        `${Math.round(tunnelReadyTimeoutMs / 1000).toString()}s.`,
    );
  }

  const listeningPid = await findListeningProcessId(session.localPort);
  if (listeningPid === undefined) {
    throw new CfDebuggerError(
      "TUNNEL_OWNER_UNVERIFIED",
      `Could not verify the owner of local tunnel port ${session.localPort.toString()}.`,
    );
  }
  if (listeningPid !== childPid) {
    throw new CfDebuggerError(
      "TUNNEL_OWNER_MISMATCH",
      `Local tunnel port ${session.localPort.toString()} is owned by an unexpected process.`,
    );
  }
}

function attachTunnelEvents(
  child: ChildProcess,
  resolveExit: (code: number | null) => void,
  emit: StatusEmitter,
): void {
  child.on("close", (code) => {
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
      const attempt = disposePromise ?? (async (): Promise<void> => {
        await runCleanupActions([
          (): void => {
            emit("stopping");
          },
          async (): Promise<void> => {
            await updateSessionStatus(session.sessionId, "stopping");
          },
          finalize,
        ], "Debugger disposal failed");
      })();
      disposePromise = attempt;
      try {
        await attempt;
      } catch (error: unknown) {
        if (disposePromise === attempt) {
          disposePromise = undefined;
        }
        throw error;
      }
    },
    waitForExit: async (): Promise<number | null> => {
      return await exitPromise;
    },
  };
}

async function runCleanupActions(
  actions: readonly (() => void | Promise<void>)[],
  aggregateMessage: string,
): Promise<void> {
  let errors: readonly unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error: unknown) {
      errors = [...errors, error];
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, aggregateMessage);
  }
}

async function prepareCfHome(cfHomeDir: string): Promise<void> {
  await mkdir(cfHomeDir, { recursive: true, mode: 0o700 });
  await chmod(cfHomeDir, 0o700);
}

function createTunnelLifecycle(session: ActiveSession, emit: StatusEmitter): TunnelLifecycle {
  let child: ChildProcess | undefined;
  let exitResolve: (code: number | null) => void = (_code) => {
    throw new Error("Exit resolver was used before initialization");
  };
  const exitPromise = new Promise<number | null>((resolve) => {
    exitResolve = resolve;
  });
  const observeChild = (tunnelChild: ChildProcess): void => {
    child = tunnelChild;
    attachTunnelEvents(tunnelChild, exitResolve, emit);
  };
  const finalize = async (): Promise<void> => {
    const termination = child === undefined
      ? "terminated"
      : await killProcessGroupOrProc(child);
    const portListening = child !== undefined && await isPortListening(session.localPort);
    if (termination === "still-alive" || portListening) {
      throw new CfDebuggerError(
        "TUNNEL_TERMINATION_FAILED",
        `Tunnel for session ${session.sessionId} did not terminate; state and CF home were retained.`,
      );
    }
    await runCleanupActions([
      async (): Promise<void> => {
        await removeSession(session.sessionId);
      },
      async (): Promise<void> => {
        await cleanupFilesystem(session.cfHomeDir);
      },
    ], "Debugger resource cleanup failed");
    emit("stopped");
  };
  return { exitPromise, finalize, observeChild };
}

async function establishDebuggerSession(inputs: StartupInputs): Promise<ActiveSession> {
  const { options, target, session, context, credentials, timeoutMs, lifecycle, emit } = inputs;
  await prepareCfHome(session.cfHomeDir);
  await loginAndTarget(
    options,
    session.apiEndpoint,
    credentials.email,
    credentials.password,
    context,
    session.sessionId,
    emit,
  );
  await ensurePortAvailable(session.localPort);
  const remoteNodePid = await signalRemoteNode(options, target, context, session.sessionId, emit);
  const remoteState = requireStartupState(
    await updateSessionRemoteNodePid(session.sessionId, remoteNodePid),
  );
  if (remoteState.remoteNodePid !== remoteNodePid) {
    throw new CfDebuggerError(
      "SESSION_STATE_CONFLICT",
      "Debugger session did not retain the selected remote Node PID.",
    );
  }
  await waitAfterSignal(context.signal);

  emit("tunneling");
  await transitionStartupStatus(session.sessionId, "tunneling");
  await openReadyTunnel(
    options, target, session, context, timeoutMs, lifecycle.observeChild,
  );
  emit("ready");
  return await transitionStartupStatus(session.sessionId, "ready");
}

async function failAfterStartupCleanup(
  error: unknown,
  finalize: () => Promise<void>,
  emit: StatusEmitter,
): Promise<never> {
  try {
    await runCleanupActions([
      (): void => {
        emit("error", error instanceof Error ? error.message : String(error));
      },
      finalize,
    ], "Debugger startup failure reporting and cleanup failed");
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [error, cleanupError],
      "Debugger startup failed and resource cleanup was incomplete",
      { cause: cleanupError },
    );
  }
  throw error;
}

export async function startDebugger(options: StartDebuggerOptions): Promise<DebuggerHandle> {
  const target = resolveNodeTarget(options);
  const credentials = requireCredentials(options);
  const apiEndpoint = resolveApiEndpoint(options.region, options.apiEndpoint);
  const tunnelReadyTimeoutMs = options.tunnelReadyTimeoutMs ?? DEFAULT_TUNNEL_READY_TIMEOUT_MS;
  const emit = (status: SessionStatus, message?: string): void => {
    options.onStatus?.(status, message);
  };

  checkAbort(options.signal);
  await pruneAndCleanupOrphans();

  const session = await registerSession(options, target, apiEndpoint);
  const cancellation = createStartupCancellation(session.sessionId, options.signal);
  const context: CfExecContext = {
    cfHome: session.cfHomeDir,
    signal: cancellation.signal,
  };
  const lifecycle = createTunnelLifecycle(session, emit);

  try {
    const activeSession = await establishDebuggerSession({
      options,
      target,
      session,
      context,
      credentials,
      timeoutMs: tunnelReadyTimeoutMs,
      lifecycle,
      emit,
    });
    cancellation.dispose();
    return createHandle(activeSession, emit, lifecycle.finalize, lifecycle.exitPromise);
  } catch (err: unknown) {
    cancellation.dispose();
    return await failAfterStartupCleanup(err, lifecycle.finalize, emit);
  }
}

async function cleanupFilesystem(cfHomeDir: string): Promise<void> {
  await rm(cfHomeDir, { recursive: true, force: true });
}
