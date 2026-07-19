import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { CfDebuggerError } from "../types.js";

import {
  buildEnv,
  DEFAULT_CF_COMMAND_TIMEOUT_MS,
  resolveBin,
  type CfExecContext,
} from "./execute.js";
import {
  DEFAULT_CF_PROCESS,
  resolveNodeTarget,
  type NodeTargetSelectors,
} from "./node-process.js";

const DEFAULT_MAX_OUTPUT_BYTES = 65_536;

export interface CfSshSignalResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
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

interface BoundedOutput {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

interface SshExecutionState {
  readonly stdout: BoundedOutput;
  readonly stderr: BoundedOutput;
  settled: boolean;
  aborted: boolean;
  timedOut: boolean;
  timeoutTimer?: NodeJS.Timeout;
  forceKillTimer?: NodeJS.Timeout;
}

export function buildCfSshArgs(
  appName: string,
  target: NodeTargetSelectors,
  tail: readonly string[],
): readonly string[] {
  const resolved = resolveNodeTarget(target);
  const processArgs = resolved.process === DEFAULT_CF_PROCESS
    ? []
    : ["--process", resolved.process];
  return [
    "ssh",
    appName,
    ...processArgs,
    "-i",
    resolved.instance.toString(),
    ...tail,
  ];
}

export async function cfSshOneShot(
  appName: string,
  command: string,
  context: CfExecContext,
  rawOptions: number | CfSshOptions = DEFAULT_CF_COMMAND_TIMEOUT_MS,
): Promise<CfSshSignalResult> {
  const options = resolveSshOptions(rawOptions);
  const args = buildCfSshArgs(appName, options.target, [
    "--disable-pseudo-tty",
    "-c",
    command,
  ]);
  return await runSshOneShot(args, context, options);
}

function resolveSshOptions(raw: number | CfSshOptions): ResolvedSshOptions {
  const input = typeof raw === "number" ? { timeoutMs: raw } : raw;
  const timeoutMs = input.timeoutMs ?? DEFAULT_CF_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RangeError("maxOutputBytes must be a positive safe integer");
  }
  return { target: input, timeoutMs, maxOutputBytes };
}

function createBoundedOutput(): BoundedOutput {
  return { chunks: [], bytes: 0, truncated: false };
}

function appendBounded(output: BoundedOutput, data: Buffer | string, limit: number): void {
  const incoming = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const remaining = Math.max(0, limit - output.bytes);
  if (incoming.byteLength > remaining) {
    output.truncated = true;
  }
  if (remaining === 0) {
    return;
  }
  const next = incoming.subarray(0, remaining);
  output.chunks.push(next);
  output.bytes += next.byteLength;
}

function outputText(output: BoundedOutput): string {
  return Buffer.concat(output.chunks, output.bytes).toString("utf8");
}

function createResult(
  exitCode: number | null,
  stdout: BoundedOutput,
  stderr: BoundedOutput,
): CfSshSignalResult {
  return {
    exitCode,
    stdout: outputText(stdout),
    stderr: outputText(stderr),
    outputTruncated: stdout.truncated || stderr.truncated,
  };
}

function createSshExecutionState(): SshExecutionState {
  return {
    stdout: createBoundedOutput(),
    stderr: createBoundedOutput(),
    settled: false,
    aborted: false,
    timedOut: false,
  };
}

function terminateSshExecution(
  child: ReturnType<typeof spawn>,
  state: SshExecutionState,
): void {
  signalChild(child, "SIGTERM");
  state.forceKillTimer ??= setTimeout(() => {
    signalChild(child, "SIGKILL");
  }, 1000);
}

function createSshSettler(
  state: SshExecutionState,
  options: ResolvedSshOptions,
  signal: AbortSignal | undefined,
  onAbort: () => void,
  resolve: (result: CfSshSignalResult) => void,
  reject: (reason?: unknown) => void,
): (result: CfSshSignalResult) => void {
  return (result): void => {
    if (state.settled) {
      return;
    }
    state.settled = true;
    if (state.timeoutTimer !== undefined) {
      clearTimeout(state.timeoutTimer);
    }
    if (state.forceKillTimer !== undefined) {
      clearTimeout(state.forceKillTimer);
    }
    signal?.removeEventListener("abort", onAbort);
    if (state.aborted) {
      reject(new CfDebuggerError("ABORTED", "Operation aborted by caller"));
      return;
    }
    resolve(state.timedOut ? { ...result, timedOutAfterMs: options.timeoutMs } : result);
  };
}

function attachSshExecution(
  child: ChildProcessByStdio<null, Readable, Readable>,
  context: CfExecContext,
  options: ResolvedSshOptions,
  resolve: (result: CfSshSignalResult) => void,
  reject: (reason?: unknown) => void,
): void {
  const state = createSshExecutionState();
  const onAbort = (): void => {
    state.aborted = true;
    terminateSshExecution(child, state);
  };
  const settle = createSshSettler(state, options, context.signal, onAbort, resolve, reject);
  state.timeoutTimer = setTimeout(() => {
    state.timedOut = true;
    terminateSshExecution(child, state);
  }, options.timeoutMs);
  if (context.signal?.aborted) {
    onAbort();
  } else {
    context.signal?.addEventListener("abort", onAbort, { once: true });
  }
  child.stdout.on("data", (data: Buffer | string) => {
    appendBounded(state.stdout, data, options.maxOutputBytes);
  });
  child.stderr.on("data", (data: Buffer | string) => {
    appendBounded(state.stderr, data, options.maxOutputBytes);
  });
  child.on("close", (code, signal) => {
    const base = createResult(code, state.stdout, state.stderr);
    settle(state.timedOut || signal === null ? base : { ...base, signal });
  });
  child.on("error", (error: Error) => {
    appendBounded(state.stderr, error.message, options.maxOutputBytes);
    settle(createResult(null, state.stdout, state.stderr));
  });
}

function runSshOneShot(
  args: readonly string[],
  context: CfExecContext,
  options: ResolvedSshOptions,
): Promise<CfSshSignalResult> {
  if (context.signal?.aborted) {
    return Promise.reject(new CfDebuggerError("ABORTED", "Operation aborted by caller"));
  }
  return new Promise<CfSshSignalResult>((resolve, reject) => {
    const child = spawn(resolveBin(context), [...args], {
      env: buildEnv(context.cfHome),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    attachSshExecution(child, context, options, resolve, reject);
  });
}

function signalChild(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
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

export function isSshDisabledError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return lower.includes("not authorized") || lower.includes("ssh support is disabled");
}

export function spawnSshTunnel(
  appName: string,
  localPort: number,
  remotePort: number,
  context: CfExecContext,
  target: NodeTargetSelectors = {},
): ReturnType<typeof spawn> {
  const tunnelArg = `${localPort.toString()}:localhost:${remotePort.toString()}`;
  const args = buildCfSshArgs(appName, target, ["-N", "-L", tunnelArg]);
  const child = spawn(resolveBin(context), [...args], {
    env: buildEnv(context.cfHome),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}
