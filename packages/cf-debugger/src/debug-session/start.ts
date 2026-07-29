import { chmod, mkdir } from "node:fs/promises";
import nodeProcess from "node:process";

import {
  cfAppExists,
  cfLogin,
  cfTarget,
  type CfExecContext,
  type CfRetryStatus,
} from "../cf.js";
import {
  DEFAULT_NODE_INSPECTOR_PORT,
  resolveNodeTarget,
  type ResolvedNodeTarget,
} from "../cloud-foundry/node-process.js";
import { validateCfCliOperand } from "../input-validation.js";
import { sessionCfHomeDir } from "../paths.js";
import { isPortFree } from "../port.js";
import { resolveApiEndpoint } from "../regions.js";
import { applyRestartEnvironmentVeto } from "../restart-policy.js";
import {
  registerNewSession,
  sessionKeyString,
  updateSessionRemoteNodePid,
  updateSessionStatus,
} from "../state.js";
import type { StateAccessOptions } from "../state.js";
import type {
  ActiveSession,
  DebuggerHandle,
  SessionStatus,
  StartDebuggerOptions,
} from "../types.js";
import { CfDebuggerError } from "../types.js";

import { DEFAULT_TUNNEL_READY_TIMEOUT_MS } from "./constants.js";
import {
  cleanupFailedStartup,
  createDebuggerHandle,
  createTunnelLifecycle,
} from "./lifecycle.js";
import { pruneAndCleanupOrphans } from "./orphans.js";
import { createStartupCancellation } from "./startup-cancellation.js";
import {
  createStartupDeadline,
  remainingStartupMs,
  resolveStartupTimeoutMs,
  type StartupDeadline,
  startupTimeoutError,
  throwIfStartupAborted,
} from "./startup-deadline.js";
import { signalRemoteNode } from "./startup-remote.js";
import { openReadyTunnel } from "./startup-tunnel.js";

type StatusEmitter = (status: SessionStatus, message?: string) => void;

interface StatusTracker {
  readonly emit: StatusEmitter;
  readonly current: () => SessionStatus;
}

interface StartupInputs {
  readonly options: StartDebuggerOptions;
  readonly target: ResolvedNodeTarget;
  readonly session: ActiveSession;
  readonly context: CfExecContext;
  readonly credentials: Credentials;
  readonly tunnelReadyTimeoutMs: number;
  readonly emit: StatusEmitter;
  readonly transition: (
    status: SessionStatus,
    message?: string,
  ) => Promise<ActiveSession>;
  readonly lifecycle: ReturnType<typeof createTunnelLifecycle>;
}

interface Credentials {
  readonly email: string;
  readonly password: string;
}

interface ResolvedStartupPlan {
  readonly apiEndpoint: string;
  readonly credentials: Credentials;
  readonly options: StartDebuggerOptions;
  readonly target: ResolvedNodeTarget;
  readonly tracker: StatusTracker;
  readonly tunnelReadyTimeoutMs: number;
}

interface StartupResources {
  cancellation?: ReturnType<typeof createStartupCancellation>;
  lifecycle?: ReturnType<typeof createTunnelLifecycle>;
}

function validateStartTarget(options: StartDebuggerOptions): StartDebuggerOptions {
  return {
    ...options,
    app: validateCfCliOperand(options.app, "app"),
    org: validateCfCliOperand(options.org, "org"),
    space: validateCfCliOperand(options.space, "space"),
  };
}

function requireCredentials(options: StartDebuggerOptions): Credentials {
  const email = options.email ?? nodeProcess.env["SAP_EMAIL"];
  const password = options.password ?? nodeProcess.env["SAP_PASSWORD"];
  if (email === undefined || email.length === 0) {
    throw new CfDebuggerError(
      "MISSING_CREDENTIALS",
      "SAP email is required. Pass `email` or set SAP_EMAIL.",
    );
  }
  if (password === undefined || password.length === 0) {
    throw new CfDebuggerError(
      "MISSING_CREDENTIALS",
      "SAP password is required. Pass `password` or set SAP_PASSWORD.",
    );
  }
  return { email, password };
}

function resolveTunnelReadyTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_TUNNEL_READY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new CfDebuggerError(
      "UNSAFE_INPUT",
      "Tunnel-ready timeout must be a positive integer number of milliseconds.",
    );
  }
  return timeoutMs;
}

async function registerSession(
  options: StartDebuggerOptions,
  target: ResolvedNodeTarget,
  apiEndpoint: string,
  deadline: StartupDeadline,
): Promise<ActiveSession> {
  const portProbe = async (port: number): Promise<boolean> => {
    throwIfStartupAborted(
      deadline.signal,
      deadline.expiresAt,
      deadline.timeoutMs,
      "local port selection",
    );
    const available = await isPortFree(port, deadline.signal);
    throwIfStartupAborted(
      deadline.signal,
      deadline.expiresAt,
      deadline.timeoutMs,
      "local port selection",
    );
    return available;
  };
  const registration = await registerNewSession({
    region: options.region,
    org: options.org,
    space: options.space,
    app: options.app,
    process: target.process,
    instance: target.instance,
    ...(target.nodePid === undefined ? {} : { nodePid: target.nodePid }),
    apiEndpoint,
    remotePort: options.remotePort ?? DEFAULT_NODE_INSPECTOR_PORT,
    startupTimeoutMs: deadline.timeoutMs,
    ...(options.preferredPort === undefined ? {} : { preferredPort: options.preferredPort }),
    portProbe,
    cfHomeForSession: sessionCfHomeDir,
    stateAccess: startupStateAccess(deadline.signal, deadline.expiresAt),
  });
  if (registration.existing !== undefined) {
    throw new CfDebuggerError(
      "SESSION_ALREADY_RUNNING",
      `A debugger session already exists for ${sessionKeyString(options)} on port ` +
        `${registration.existing.localPort.toString()} (session ${registration.existing.sessionId}).`,
    );
  }
  return registration.session;
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

function startupStateAccess(
  signal: AbortSignal | undefined,
  expiresAt: number | undefined,
): StateAccessOptions {
  return {
    ...(signal === undefined ? {} : { signal }),
    ...(expiresAt === undefined
      ? {}
      : { timeoutMs: Math.max(1, remainingStartupMs(expiresAt)) }),
  };
}

function createTransition(
  sessionId: string,
  context: CfExecContext,
): StartupInputs["transition"] {
  return async (status, message): Promise<ActiveSession> => {
    return requireStartupState(
      await updateSessionStatus(
        sessionId,
        status,
        message,
        startupStateAccess(context.signal, context.deadlineAt),
      ),
      status,
    );
  };
}

async function prepareCfHome(cfHomeDir: string): Promise<void> {
  await mkdir(cfHomeDir, { recursive: true, mode: 0o700 });
  await chmod(cfHomeDir, 0o700);
}

async function loginAndTarget(inputs: StartupInputs): Promise<void> {
  const { options, context, credentials, emit, transition } = inputs;
  emit("logging-in");
  await transition("logging-in");
  await cfLogin(
    inputs.session.apiEndpoint,
    credentials.email,
    credentials.password,
    { ...context, phase: "Cloud Foundry login" },
  );
  emit("targeting");
  await transition("targeting");
  const targetingContext = { ...context, phase: "Cloud Foundry target selection" };
  await cfTarget(options.org, options.space, targetingContext);
  if (!(await cfAppExists(options.app, targetingContext))) {
    throw new CfDebuggerError(
      "APP_NOT_FOUND",
      `Cloud Foundry app ${options.app} was not found in ${options.org}/${options.space}.`,
    );
  }
}

async function ensurePortAvailable(
  localPort: number,
  context: CfExecContext,
): Promise<void> {
  if (!(await isPortFree(localPort, context.signal))) {
    throw new CfDebuggerError(
      "PORT_UNAVAILABLE",
      `Local port ${localPort.toString()} was taken before remote signalling began.`,
    );
  }
}

async function recordRemoteNodePid(
  sessionId: string,
  remoteNodePid: number,
  context: CfExecContext,
): Promise<void> {
  const state = requireStartupState(
    await updateSessionRemoteNodePid(
      sessionId,
      remoteNodePid,
      startupStateAccess(context.signal, context.deadlineAt),
    ),
  );
  if (state.remoteNodePid !== remoteNodePid) {
    throw new CfDebuggerError(
      "SESSION_STATE_CONFLICT",
      "Debugger session did not retain the selected remote Node PID.",
    );
  }
}

async function establishDebuggerSession(inputs: StartupInputs): Promise<ActiveSession> {
  await prepareCfHome(inputs.session.cfHomeDir);
  await loginAndTarget(inputs);
  await ensurePortAvailable(inputs.session.localPort, inputs.context);
  const remoteNodePid = await signalRemoteNode({
    options: inputs.options,
    target: inputs.target,
    context: inputs.context,
    transition: inputs.transition,
    emit: inputs.emit,
    warn: writeWarning,
  });
  throwIfStartupAborted(
    inputs.context.signal,
    inputs.context.deadlineAt ?? Number.MAX_SAFE_INTEGER,
    inputs.context.startupTimeoutMs ?? Number.MAX_SAFE_INTEGER,
    "remote inspector signalling",
  );
  await recordRemoteNodePid(inputs.session.sessionId, remoteNodePid, inputs.context);
  inputs.emit("tunneling");
  await inputs.transition("tunneling");
  await openReadyTunnel({
    options: inputs.options,
    target: inputs.target,
    session: inputs.session,
    context: inputs.context,
    tunnelReadyTimeoutMs: inputs.tunnelReadyTimeoutMs,
    onChild: inputs.lifecycle.observeChild,
  });
  const readySession = await inputs.transition("ready");
  inputs.lifecycle.assertRunning();
  inputs.emit("ready");
  return readySession;
}

function writeWarning(message: string): void {
  nodeProcess.stderr.write(`[cf-debugger] warning: ${message}\n`);
}

function writeTunnelOutput(stream: "stderr" | "stdout", text: string): void {
  nodeProcess.stderr.write(`[cf-debugger tunnel ${stream}] ${text}\n`);
}

function retryMessage(status: CfRetryStatus): string {
  const remainingSeconds = Math.ceil(status.remainingMs / 1000);
  return `${status.command} attempt ${status.attempt.toString()} failed; retrying in ` +
    `${status.delayMs.toString()}ms (${remainingSeconds.toString()}s startup budget left)`;
}

function createStatusTracker(options: StartDebuggerOptions): StatusTracker {
  let currentStatus: SessionStatus = "starting";
  return {
    current: (): SessionStatus => currentStatus,
    emit: (status, message): void => {
      currentStatus = status;
      try {
        options.onStatus?.(status, message);
      } catch {
        writeWarning("The onStatus callback threw; lifecycle cleanup will continue.");
      }
    },
  };
}

function createCfContext(
  session: ActiveSession,
  credentials: Credentials,
  cancellation: ReturnType<typeof createStartupCancellation>,
  deadline: ReturnType<typeof createStartupDeadline>,
  tracker: StatusTracker,
  verbose: boolean,
): CfExecContext {
  return {
    cfHome: session.cfHomeDir,
    signal: cancellation.signal,
    deadlineAt: deadline.expiresAt,
    startupTimeoutMs: deadline.timeoutMs,
    sensitiveValues: [credentials.email, credentials.password],
    ...(verbose
      ? {
          onRetry: (status: CfRetryStatus): void => {
            tracker.emit(tracker.current(), retryMessage(status));
          },
          onTunnelOutput: writeTunnelOutput,
        }
      : {}),
  };
}

function normalizeStartupError(
  error: unknown,
  expiresAt: number,
  timeoutMs: number,
): unknown {
  if (
    error instanceof CfDebuggerError &&
    error.code === "ABORTED" &&
    remainingStartupMs(expiresAt) === 0
  ) {
    return startupTimeoutError(timeoutMs, "startup");
  }
  return error;
}

function resolveStartupPlan(options: StartDebuggerOptions): ResolvedStartupPlan {
  const validatedOptions = validateStartTarget(options);
  const restartAllowed = applyRestartEnvironmentVeto(
    validatedOptions.allowSshEnableRestart,
    nodeProcess.env["CF_DEBUGGER_ALLOW_RESTART"],
  );
  const effectiveOptions = restartAllowed === validatedOptions.allowSshEnableRestart
    ? validatedOptions
    : { ...validatedOptions, allowSshEnableRestart: restartAllowed };
  const target = resolveNodeTarget(effectiveOptions);
  const credentials = requireCredentials(effectiveOptions);
  const apiEndpoint = resolveApiEndpoint(
    effectiveOptions.region,
    effectiveOptions.apiEndpoint,
    writeWarning,
  );
  const tunnelReadyTimeoutMs = resolveTunnelReadyTimeoutMs(
    effectiveOptions.tunnelReadyTimeoutMs,
  );
  return {
    apiEndpoint,
    credentials,
    options: effectiveOptions,
    target,
    tracker: createStatusTracker(effectiveOptions),
    tunnelReadyTimeoutMs,
  };
}

async function completeStartup(
  plan: ResolvedStartupPlan,
  deadline: StartupDeadline,
  resources: StartupResources,
): Promise<DebuggerHandle> {
  throwIfStartupAborted(
    deadline.signal,
    deadline.expiresAt,
    deadline.timeoutMs,
    "initialization",
  );
  await pruneAndCleanupOrphans(startupStateAccess(deadline.signal, deadline.expiresAt));
  throwIfStartupAborted(
    deadline.signal,
    deadline.expiresAt,
    deadline.timeoutMs,
    "state cleanup",
  );
  const session = await registerSession(
    plan.options,
    plan.target,
    plan.apiEndpoint,
    deadline,
  );
  resources.cancellation = createStartupCancellation(session.sessionId, deadline.signal);
  const context = createCfContext(
    session,
    plan.credentials,
    resources.cancellation,
    deadline,
    plan.tracker,
    plan.options.verbose === true,
  );
  resources.lifecycle = createTunnelLifecycle(session, plan.tracker.emit);
  const activeSession = await establishDebuggerSession({
    options: { ...plan.options, remotePort: session.remotePort },
    target: plan.target,
    session,
    context,
    credentials: plan.credentials,
    tunnelReadyTimeoutMs: plan.tunnelReadyTimeoutMs,
    emit: plan.tracker.emit,
    transition: createTransition(session.sessionId, context),
    lifecycle: resources.lifecycle,
  });
  resources.cancellation.dispose();
  deadline.dispose();
  return createDebuggerHandle(activeSession, plan.tracker.emit, resources.lifecycle);
}

async function handleStartupFailure(
  error: unknown,
  plan: ResolvedStartupPlan,
  resources: StartupResources,
  deadline: StartupDeadline,
): Promise<DebuggerHandle> {
  resources.cancellation?.dispose();
  deadline.dispose();
  const normalized = normalizeStartupError(
    error,
    deadline.expiresAt,
    deadline.timeoutMs,
  );
  if (resources.lifecycle !== undefined) {
    return await cleanupFailedStartup(normalized, resources.lifecycle, plan.tracker.emit);
  }
  plan.tracker.emit(
    "error",
    normalized instanceof Error ? normalized.message : String(normalized),
  );
  throw normalized;
}

async function startDebuggerUsingDeadline(
  options: StartDebuggerOptions,
  deadline: StartupDeadline,
): Promise<DebuggerHandle> {
  const plan = resolveStartupPlan(options);
  const resources: StartupResources = {};
  plan.tracker.emit("starting");
  try {
    return await completeStartup(plan, deadline, resources);
  } catch (error: unknown) {
    return await handleStartupFailure(error, plan, resources, deadline);
  }
}

export async function startDebuggerWithinDeadline(
  options: StartDebuggerOptions,
  deadline: StartupDeadline,
): Promise<DebuggerHandle> {
  try {
    return await startDebuggerUsingDeadline(options, deadline);
  } catch (error: unknown) {
    deadline.dispose();
    throw error;
  }
}

export async function startDebugger(options: StartDebuggerOptions): Promise<DebuggerHandle> {
  const startupTimeoutMs = resolveStartupTimeoutMs(options.startupTimeoutMs);
  const deadline = createStartupDeadline(startupTimeoutMs, options.signal);
  return await startDebuggerWithinDeadline(options, deadline);
}
