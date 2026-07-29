import {
  spawn,
  type ChildProcessByStdio,
} from "node:child_process";
import nodeProcess from "node:process";
import type { Readable } from "node:stream";

import {
  inspectProcessIdentity,
  readProcessIdentity,
} from "../debug-session/process-identity.js";
import { CfDebuggerError } from "../types.js";

import {
  buildEnv,
  DEFAULT_CF_COMMAND_TIMEOUT_MS,
  resolveBin,
  type CfExecContext,
} from "./execute.js";
import type { NodeTargetSelectors } from "./node-process.js";
import {
  appendHead,
  buildCfSshArgs,
  createBoundedOutput,
  createRedactionPolicy,
  DEFAULT_MAX_OUTPUT_BYTES,
  isDeadlineExpired,
  safeOutputText,
  sshAbortError,
  type BoundedOutput,
  type RedactionPolicy,
} from "./ssh-shared.js";

export interface CfSshSignalResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Compatibility aggregate; parsing decisions should use the stream-specific fields. */
  readonly outputTruncated: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly signal?: NodeJS.Signals;
  readonly timedOutAfterMs?: number;
}

export interface CfSshOptions extends NodeTargetSelectors {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

interface ResolvedSshOptions {
  readonly target: NodeTargetSelectors;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

interface SshExecutionState {
  readonly stdout: BoundedOutput;
  readonly stderr: BoundedOutput;
  readonly outputLimit: number;
  readonly retainedLimit: number;
  readonly redaction: RedactionPolicy;
  settled: boolean;
  aborted: boolean;
  timedOut: boolean;
  terminationStarted: boolean;
  timeoutTimer?: NodeJS.Timeout;
  forceKillTimer?: NodeJS.Timeout;
}

export async function cfSshOneShot(
  appName: string,
  command: string,
  context: CfExecContext,
  rawOptions: number | CfSshOptions = DEFAULT_CF_COMMAND_TIMEOUT_MS,
): Promise<CfSshSignalResult> {
  if (context.signal?.aborted || isDeadlineExpired(context)) {
    throw sshAbortError(context);
  }
  const options = resolveSshOptions(rawOptions, context);
  const args = buildCfSshArgs(appName, options.target, [
    "--disable-pseudo-tty",
    "-c",
    command,
  ]);
  return await runSshOneShot(args, context, options);
}

function resolveSshOptions(
  raw: number | CfSshOptions,
  context: CfExecContext,
): ResolvedSshOptions {
  const input = typeof raw === "number" ? { timeoutMs: raw } : raw;
  const requestedTimeoutMs = input.timeoutMs ?? DEFAULT_CF_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(requestedTimeoutMs) || requestedTimeoutMs <= 0) {
    throw new CfDebuggerError("UNSAFE_INPUT", "timeoutMs must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new CfDebuggerError("UNSAFE_INPUT", "maxOutputBytes must be a positive safe integer.");
  }
  const remainingMs = context.deadlineAt === undefined
    ? requestedTimeoutMs
    : Math.max(1, context.deadlineAt - Date.now());
  return {
    target: input,
    timeoutMs: Math.min(requestedTimeoutMs, remainingMs),
    maxOutputBytes,
  };
}

function createResult(
  exitCode: number | null,
  state: SshExecutionState,
): CfSshSignalResult {
  const stdout = safeOutputText(state.stdout, state.redaction, state.outputLimit, "head");
  const stderr = safeOutputText(state.stderr, state.redaction, state.outputLimit, "head");
  return {
    exitCode,
    stdout,
    stderr,
    outputTruncated: state.stdout.truncated || state.stderr.truncated,
    stdoutTruncated: state.stdout.truncated,
    stderrTruncated: state.stderr.truncated,
  };
}

function createSshExecutionState(
  context: CfExecContext,
  outputLimit: number,
): SshExecutionState {
  const redaction = createRedactionPolicy(context.sensitiveValues ?? []);
  return {
    stdout: createBoundedOutput(),
    stderr: createBoundedOutput(),
    outputLimit,
    retainedLimit: outputLimit + redaction.overlapBytes,
    redaction,
    settled: false,
    aborted: false,
    timedOut: false,
    terminationStarted: false,
  };
}

function childIsOpen(child: ReturnType<typeof spawn>): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function captureSshChildIdentity(
  child: ReturnType<typeof spawn>,
): Promise<string | undefined> {
  if (nodeProcess.platform === "win32" || child.pid === undefined) {
    return;
  }
  try {
    return await readProcessIdentity(child.pid);
  } catch {
    return;
  }
}

async function canSignalSshChild(
  child: ReturnType<typeof spawn>,
  childIdentity: Promise<string | undefined>,
  signal: NodeJS.Signals,
): Promise<boolean> {
  if (!childIsOpen(child) || child.pid === undefined) {
    return false;
  }
  const expectedIdentity = await childIdentity;
  if (expectedIdentity === undefined) {
    // A still-open ChildProcess handle proves this process was spawned by us,
    // but without a birth token it is not strong enough for forced escalation.
    return signal === "SIGTERM" && childIsOpen(child);
  }
  return await inspectProcessIdentity(child.pid, expectedIdentity) === "match" &&
    childIsOpen(child);
}

function abandonUnverifiedSshChild(child: ReturnType<typeof spawn>): void {
  try {
    child.stdout?.destroy();
  } catch {
    // The stream may already have closed while identity verification was pending.
  }
  try {
    child.stderr?.destroy();
  } catch {
    // The stream may already have closed while identity verification was pending.
  }
  try {
    child.unref();
  } catch {
    // A failed spawn may not have initialized a process handle to unref.
  }
}

function terminateSshExecution(
  child: ReturnType<typeof spawn>,
  childIdentity: Promise<string | undefined>,
  state: SshExecutionState,
  settle: (result: CfSshSignalResult) => void,
): void {
  if (state.settled || state.terminationStarted) {
    return;
  }
  state.terminationStarted = true;
  const settleUnverified = (): void => {
    if (!state.settled) {
      abandonUnverifiedSshChild(child);
      settle(createResult(null, state));
    }
  };
  void (async (): Promise<void> => {
    if (!(await canSignalSshChild(child, childIdentity, "SIGTERM")) || state.settled) {
      settleUnverified();
      return;
    }
    signalChild(child, "SIGTERM");
    state.forceKillTimer = setTimeout(() => {
      void (async (): Promise<void> => {
        if (!(await canSignalSshChild(child, childIdentity, "SIGKILL")) || state.settled) {
          settleUnverified();
          return;
        }
        signalChild(child, "SIGKILL");
      })().catch(settleUnverified);
    }, 1000);
  })().catch(settleUnverified);
}

function createSshSettler(
  state: SshExecutionState,
  options: ResolvedSshOptions,
  context: CfExecContext,
  onAbort: () => void,
  resolve: (result: CfSshSignalResult) => void,
  reject: (reason?: unknown) => void,
): (result: CfSshSignalResult) => void {
  return (result): void => {
    if (state.settled) {
      return;
    }
    state.settled = true;
    clearTimeout(state.timeoutTimer);
    clearTimeout(state.forceKillTimer);
    context.signal?.removeEventListener("abort", onAbort);
    if (state.aborted) {
      reject(sshAbortError(context));
      return;
    }
    resolve(state.timedOut ? { ...result, timedOutAfterMs: options.timeoutMs } : result);
  };
}

function attachSshExecution(
  child: ChildProcessByStdio<null, Readable, Readable>,
  childIdentity: Promise<string | undefined>,
  context: CfExecContext,
  options: ResolvedSshOptions,
  resolve: (result: CfSshSignalResult) => void,
  reject: (reason?: unknown) => void,
): void {
  const state = createSshExecutionState(context, options.maxOutputBytes);
  const onAbort = (): void => {
    state.aborted = true;
    terminateSshExecution(child, childIdentity, state, settle);
  };
  const settle = createSshSettler(state, options, context, onAbort, resolve, reject);
  state.timeoutTimer = setTimeout(() => {
    state.timedOut = true;
    terminateSshExecution(child, childIdentity, state, settle);
  }, options.timeoutMs);
  if (context.signal?.aborted) {
    onAbort();
  } else {
    context.signal?.addEventListener("abort", onAbort, { once: true });
  }
  child.stdout.on("data", (data: Buffer | string) => {
    appendHead(state.stdout, data, state.outputLimit, state.retainedLimit);
  });
  child.stderr.on("data", (data: Buffer | string) => {
    appendHead(state.stderr, data, state.outputLimit, state.retainedLimit);
  });
  child.on("close", (code, signal) => {
    const base = createResult(code, state);
    settle(state.timedOut || signal === null ? base : { ...base, signal });
  });
  child.on("error", (error: Error) => {
    appendHead(state.stderr, error.message, state.outputLimit, state.retainedLimit);
    settle(createResult(null, state));
  });
}

function runSshOneShot(
  args: readonly string[],
  context: CfExecContext,
  options: ResolvedSshOptions,
): Promise<CfSshSignalResult> {
  if (context.signal?.aborted || isDeadlineExpired(context)) {
    return Promise.reject(sshAbortError(context));
  }
  return new Promise<CfSshSignalResult>((resolve, reject) => {
    const child = spawn(resolveBin(context), [...args], {
      env: buildEnv(context.cfHome),
      detached: nodeProcess.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const childIdentity = captureSshChildIdentity(child);
    attachSshExecution(child, childIdentity, context, options, resolve, reject);
  });
}

function signalChild(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (nodeProcess.platform !== "win32" && child.pid !== undefined) {
    try {
      nodeProcess.kill(-child.pid, signal);
      return;
    } catch {
      // The process may not have established its group before termination.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The child already exited between the termination request and signal.
  }
}
