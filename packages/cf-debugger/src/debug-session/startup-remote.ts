import {
  cfEnableSsh,
  cfRestartApp,
  cfSshEnabled,
  cfSshOneShot,
  isSshDisabledError,
  isSshPermissionError,
  type CfExecContext,
} from "../cf.js";
import {
  buildNodeInspectorCommand,
  DEFAULT_NODE_INSPECTOR_PORT,
  parseNodeInspectorMarkers,
  type ResolvedNodeTarget,
} from "../cloud-foundry/node-process.js";
import type { ActiveSession, SessionStatus, StartDebuggerOptions } from "../types.js";
import { CfDebuggerError } from "../types.js";

type SignalResult = Awaited<ReturnType<typeof cfSshOneShot>>;
type Transition = (
  status: SessionStatus,
  message?: string,
) => Promise<ActiveSession>;
type StatusEmitter = (status: SessionStatus, message?: string) => void;

export interface RemoteSignalInputs {
  readonly options: StartDebuggerOptions;
  readonly target: ResolvedNodeTarget;
  readonly context: CfExecContext;
  readonly transition: Transition;
  readonly emit: StatusEmitter;
  readonly warn: (message: string) => void;
}

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

function warnOnTruncatedStderr(
  inputs: RemoteSignalInputs,
  result: SignalResult,
): void {
  if (result.stderrTruncated) {
    inputs.warn(
      "Remote SSH stderr diagnostics were truncated; inspector marker parsing used complete stdout.",
    );
  }
}

function parseSignalResult(
  appName: string,
  remotePort: number,
  result: SignalResult,
): number {
  if (result.exitCode !== 0) {
    throw new CfDebuggerError(
      "USR1_SIGNAL_FAILED",
      `Failed to send SIGUSR1 to the Node.js process on ${appName}: ${signalFailureDetail(result)}`,
      result.stderr,
    );
  }
  if (result.stdoutTruncated) {
    throw new CfDebuggerError(
      "INSPECTOR_OUTPUT_TOO_LARGE",
      "Inspector startup stdout exceeded the configured capture limit.",
      result.stderr,
    );
  }
  return parseNodeInspectorMarkers(result.stdout, remotePort).remoteNodePid;
}

async function executeRemoteSignal(inputs: RemoteSignalInputs): Promise<SignalResult> {
  const { options, target, context } = inputs;
  return await cfSshOneShot(
    options.app,
    buildNodeInspectorCommand(target.nodePid, options.remotePort),
    { ...context, phase: "remote inspector signalling" },
    {
      process: target.process,
      instance: target.instance,
    },
  );
}

function restartRefusal(options: StartDebuggerOptions, stderr: string): CfDebuggerError {
  return new CfDebuggerError(
    "SSH_NOT_ENABLED",
    `SSH is disabled for ${options.app}. Re-run with --allow-ssh-enable-restart, or run ` +
      `\`cf enable-ssh ${options.app} && cf restart ${options.app}\` manually.`,
    stderr,
  );
}

function ensureRestartSafe(inputs: RemoteSignalInputs, stderr: string): void {
  if (inputs.options.allowSshEnableRestart !== true) {
    throw restartRefusal(inputs.options, stderr);
  }
  if (inputs.target.nodePid !== undefined) {
    throw new CfDebuggerError(
      "NODE_PID_RESTART_UNSAFE",
      `Cannot restart ${inputs.options.app} while targeting Node PID ` +
        `${inputs.target.nodePid.toString()}; restart manually and select its new PID.`,
      stderr,
    );
  }
}

async function enableAppSsh(inputs: RemoteSignalInputs, stderr: string): Promise<void> {
  ensureRestartSafe(inputs, stderr);
  const state = await cfSshEnabled(
    inputs.options.app,
    { ...inputs.context, phase: "checking app SSH state" },
  );
  if (state === "enabled") {
    throw new CfDebuggerError(
      "SSH_NOT_ENABLED",
      `SSH is already enabled for ${inputs.options.app}, so restarting it is not a remedy. ` +
        "Check space-level SSH policy and your Developer role.",
      stderr,
    );
  }
  if (state === "unknown") {
    throw new CfDebuggerError(
      "SSH_STATE_UNKNOWN",
      `Could not verify whether SSH is enabled for ${inputs.options.app}; no deployment change was made.`,
      stderr,
    );
  }
  inputs.emit("ssh-enabling", "Enabling app-level SSH");
  await inputs.transition("ssh-enabling", "Enabling app-level SSH");
  await cfEnableSsh(
    inputs.options.app,
    { ...inputs.context, phase: "enabling app SSH" },
  );
  const confirmed = await cfSshEnabled(
    inputs.options.app,
    { ...inputs.context, phase: "confirming app SSH state" },
  );
  if (confirmed !== "enabled") {
    throw new CfDebuggerError(
      "SSH_STATE_UNKNOWN",
      `App-level SSH enablement for ${inputs.options.app} could not be confirmed; no restart was attempted.`,
    );
  }
}

async function enableAndRestart(inputs: RemoteSignalInputs, stderr: string): Promise<void> {
  await enableAppSsh(inputs, stderr);
  const { app, org, space } = inputs.options;
  inputs.warn(
    `Restarting app ${app} in ${org}/${space} so newly enabled SSH becomes active.`,
  );
  inputs.emit("ssh-restarting", "Restarting app so SSH becomes active");
  await inputs.transition("ssh-restarting", "Restarting app so SSH becomes active");
  await cfRestartApp(app, { ...inputs.context, phase: "restarting the app" });
}

async function retrySignal(inputs: RemoteSignalInputs): Promise<number> {
  inputs.emit("signaling");
  await inputs.transition("signaling");
  const result = await executeRemoteSignal(inputs);
  warnOnTruncatedStderr(inputs, result);
  if (result.exitCode !== 0) {
    throw new CfDebuggerError(
      "USR1_SIGNAL_FAILED",
      `Failed to signal ${inputs.options.app} after enabling SSH: ${signalFailureDetail(result)}`,
      result.stderr,
    );
  }
  return parseSignalResult(
    inputs.options.app,
    inputs.options.remotePort ?? DEFAULT_NODE_INSPECTOR_PORT,
    result,
  );
}

export async function signalRemoteNode(inputs: RemoteSignalInputs): Promise<number> {
  inputs.emit("signaling");
  await inputs.transition("signaling");
  const result = await executeRemoteSignal(inputs);
  warnOnTruncatedStderr(inputs, result);
  const remotePort = inputs.options.remotePort ?? DEFAULT_NODE_INSPECTOR_PORT;
  if (result.exitCode === 0) {
    return parseSignalResult(inputs.options.app, remotePort, result);
  }
  if (isSshPermissionError(result.stderr)) {
    throw new CfDebuggerError(
      "SSH_PERMISSION_DENIED",
      `CF SSH permission was denied for ${inputs.options.app}. Check your space role and SSH policy.`,
      result.stderr,
    );
  }
  if (!isSshDisabledError(result.stderr)) {
    return parseSignalResult(inputs.options.app, remotePort, result);
  }
  await enableAndRestart(inputs, result.stderr);
  return await retrySignal(inputs);
}
