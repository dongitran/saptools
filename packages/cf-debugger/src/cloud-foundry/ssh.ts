import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import nodeProcess from "node:process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { CfDebuggerError } from "../types.js";

import {
  buildEnv,
  DEFAULT_CF_COMMAND_TIMEOUT_MS,
  normalizeSensitiveValues,
  redactSensitiveText,
  resolveBin,
  type CfExecContext,
} from "./execute.js";
import {
  DEFAULT_CF_PROCESS,
  resolveNodeTarget,
  type NodeTargetSelectors,
} from "./node-process.js";

const DEFAULT_MAX_OUTPUT_BYTES = 65_536;
const LIVE_LINE_LIMIT_BYTES = 65_536;
const MAX_REDACTION_OVERLAP_BYTES = 4096;
const SENSITIVE_OUTPUT_OMITTED = "[diagnostic output omitted to protect a sensitive value]";

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

export interface TunnelDiagnostics {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
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

interface RedactionPolicy {
  readonly safeToSurface: boolean;
  readonly sensitiveValues: readonly string[];
  readonly overlapBytes: number;
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
  timeoutTimer?: NodeJS.Timeout;
  forceKillTimer?: NodeJS.Timeout;
}

interface TunnelCapture {
  readonly stdout: BoundedOutput;
  readonly stderr: BoundedOutput;
  readonly outputLimit: number;
  readonly retainedLimit: number;
  readonly redaction: RedactionPolicy;
  readonly stderrDecoder: StringDecoder;
  readonly stdoutDecoder: StringDecoder;
  stdoutCarry: string;
  stdoutSuppressed: boolean;
  stderrCarry: string;
  stderrSuppressed: boolean;
}

const tunnelCaptures = new WeakMap<ChildProcess, TunnelCapture>();

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

function createBoundedOutput(): BoundedOutput {
  return { chunks: [], bytes: 0, truncated: false };
}

function appendHead(
  output: BoundedOutput,
  data: Buffer | string,
  outputLimit: number,
  retainedLimit: number,
): void {
  const incoming = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (incoming.byteLength === 0) {
    return;
  }
  output.truncated ||= output.bytes + incoming.byteLength > outputLimit;
  const remaining = Math.max(0, retainedLimit - output.bytes);
  if (remaining === 0) {
    return;
  }
  const next = incoming.byteLength <= remaining
    ? incoming
    : Buffer.from(incoming.subarray(0, remaining));
  output.chunks.push(next);
  output.bytes += next.byteLength;
}

function appendTail(
  output: BoundedOutput,
  data: Buffer | string,
  outputLimit: number,
  retainedLimit: number,
): void {
  const incoming = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (incoming.byteLength === 0) {
    return;
  }
  output.chunks.push(incoming);
  output.bytes += incoming.byteLength;
  output.truncated ||= output.bytes > outputLimit;
  while (output.bytes > retainedLimit && output.chunks.length > 0) {
    const first = output.chunks[0];
    if (first === undefined) {
      break;
    }
    const excess = output.bytes - retainedLimit;
    if (first.byteLength <= excess) {
      output.chunks.shift();
      output.bytes -= first.byteLength;
    } else {
      output.chunks[0] = Buffer.from(first.subarray(excess));
      output.bytes -= excess;
    }
  }
}

function outputText(output: BoundedOutput): string {
  return Buffer.concat(output.chunks, output.bytes).toString("utf8");
}

function createRedactionPolicy(values: readonly string[]): RedactionPolicy {
  const sensitiveValues = normalizeSensitiveValues(values);
  const overlapBytes = sensitiveValues.reduce(
    (largest, value) => Math.max(largest, Buffer.byteLength(value)),
    0,
  );
  return {
    safeToSurface: overlapBytes <= MAX_REDACTION_OVERLAP_BYTES &&
      !sensitiveValues.some((value) => /[\r\n]/.test(value)),
    sensitiveValues,
    overlapBytes: Math.min(overlapBytes, MAX_REDACTION_OVERLAP_BYTES),
  };
}

function limitText(text: string, limit: number, keep: "head" | "tail"): string {
  const buffer = Buffer.from(text);
  if (buffer.byteLength <= limit) {
    return text;
  }
  const limited = keep === "head"
    ? buffer.subarray(0, limit)
    : buffer.subarray(buffer.byteLength - limit);
  return limited.toString("utf8");
}

function safeOutputText(
  output: BoundedOutput,
  policy: RedactionPolicy,
  limit: number,
  keep: "head" | "tail",
): string {
  if (!policy.safeToSurface && output.bytes > 0) {
    return SENSITIVE_OUTPUT_OMITTED;
  }
  const redacted = redactSensitiveText(outputText(output), policy.sensitiveValues);
  return limitText(redacted, limit, keep);
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
  };
}

function terminateSshExecution(child: ReturnType<typeof spawn>, state: SshExecutionState): void {
  signalChild(child, "SIGTERM");
  state.forceKillTimer ??= setTimeout(() => {
    signalChild(child, "SIGKILL");
  }, 1000);
}

function sshAbortError(context: CfExecContext): CfDebuggerError {
  if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt) {
    return new CfDebuggerError(
      "STARTUP_TIMEOUT",
      `Debugger startup exceeded its configured deadline during ${context.phase ?? "remote signalling"}.`,
    );
  }
  return new CfDebuggerError("ABORTED", "Operation aborted by caller");
}

function isDeadlineExpired(context: CfExecContext): boolean {
  return context.deadlineAt !== undefined && Date.now() >= context.deadlineAt;
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
  context: CfExecContext,
  options: ResolvedSshOptions,
  resolve: (result: CfSshSignalResult) => void,
  reject: (reason?: unknown) => void,
): void {
  const state = createSshExecutionState(context, options.maxOutputBytes);
  const onAbort = (): void => {
    state.aborted = true;
    terminateSshExecution(child, state);
  };
  const settle = createSshSettler(state, options, context, onAbort, resolve, reject);
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
    attachSshExecution(child, context, options, resolve, reject);
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

export function isSshDisabledError(stderr: string): boolean {
  return stderr.toLowerCase().includes("ssh support is disabled");
}

export function isSshPermissionError(stderr: string): boolean {
  return stderr.toLowerCase().includes("not authorized");
}

function liveOutputText(capture: TunnelCapture, line: string): string {
  if (!capture.redaction.safeToSurface && line.length > 0) {
    return SENSITIVE_OUTPUT_OMITTED;
  }
  if (Buffer.byteLength(line) > LIVE_LINE_LIMIT_BYTES) {
    return "[output line omitted: exceeded live diagnostic limit]";
  }
  return redactSensitiveText(line, capture.redaction.sensitiveValues);
}

function skipSuppressedLine(
  capture: TunnelCapture,
  stream: "stderr" | "stdout",
  text: string,
): string {
  const suppressedKey = stream === "stdout"
    ? "stdoutSuppressed"
    : "stderrSuppressed";
  if (!capture[suppressedKey]) {
    return text;
  }
  const newline = text.indexOf("\n");
  if (newline < 0) {
    return "";
  }
  capture[suppressedKey] = false;
  return text.slice(newline + 1);
}

function emitCompleteLines(
  capture: TunnelCapture,
  stream: "stderr" | "stdout",
  data: Buffer | string,
  emit: CfExecContext["onTunnelOutput"],
): void {
  if (emit === undefined) {
    return;
  }
  const key = stream === "stdout" ? "stdoutCarry" : "stderrCarry";
  const suppressedKey = stream === "stdout"
    ? "stdoutSuppressed"
    : "stderrSuppressed";
  const decoder = stream === "stdout" ? capture.stdoutDecoder : capture.stderrDecoder;
  const incoming = decoder.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
  const combined = `${capture[key]}${skipSuppressedLine(capture, stream, incoming)}`;
  const lines = combined.split("\n");
  capture[key] = lines.pop() ?? "";
  for (const line of lines) {
    emit(stream, liveOutputText(capture, line.endsWith("\r") ? line.slice(0, -1) : line));
  }
  if (Buffer.byteLength(capture[key]) > LIVE_LINE_LIMIT_BYTES) {
    capture[key] = "";
    capture[suppressedKey] = true;
    emit(stream, "[output line omitted: exceeded live diagnostic limit]");
  }
}

function flushLiveCarry(
  capture: TunnelCapture,
  stream: "stderr" | "stdout",
  emit: CfExecContext["onTunnelOutput"],
): void {
  if (emit === undefined) {
    return;
  }
  const key = stream === "stdout" ? "stdoutCarry" : "stderrCarry";
  const suppressedKey = stream === "stdout"
    ? "stdoutSuppressed"
    : "stderrSuppressed";
  if (capture[suppressedKey]) {
    capture[suppressedKey] = false;
    capture[key] = "";
    return;
  }
  if (capture[key].length === 0) {
    return;
  }
  emit(stream, liveOutputText(capture, capture[key]));
  capture[key] = "";
}

function attachTunnelCapture(
  child: ChildProcessByStdio<null, Readable, Readable>,
  context: CfExecContext,
): void {
  const redaction = createRedactionPolicy(context.sensitiveValues ?? []);
  const capture: TunnelCapture = {
    stdout: createBoundedOutput(),
    stderr: createBoundedOutput(),
    outputLimit: DEFAULT_MAX_OUTPUT_BYTES,
    retainedLimit: DEFAULT_MAX_OUTPUT_BYTES + redaction.overlapBytes,
    redaction,
    stderrDecoder: new StringDecoder("utf8"),
    stdoutDecoder: new StringDecoder("utf8"),
    stdoutCarry: "",
    stdoutSuppressed: false,
    stderrCarry: "",
    stderrSuppressed: false,
  };
  tunnelCaptures.set(child, capture);
  child.stdout.on("data", (data: Buffer | string) => {
    appendTail(capture.stdout, data, capture.outputLimit, capture.retainedLimit);
    emitCompleteLines(capture, "stdout", data, context.onTunnelOutput);
  });
  child.stderr.on("data", (data: Buffer | string) => {
    appendTail(capture.stderr, data, capture.outputLimit, capture.retainedLimit);
    emitCompleteLines(capture, "stderr", data, context.onTunnelOutput);
  });
  child.on("error", (error: Error) => {
    const diagnostic = `${error.message}\n`;
    appendTail(capture.stderr, diagnostic, capture.outputLimit, capture.retainedLimit);
    emitCompleteLines(capture, "stderr", diagnostic, context.onTunnelOutput);
  });
  child.once("close", () => {
    emitCompleteLines(
      capture,
      "stdout",
      capture.stdoutDecoder.end(),
      context.onTunnelOutput,
    );
    emitCompleteLines(
      capture,
      "stderr",
      capture.stderrDecoder.end(),
      context.onTunnelOutput,
    );
    flushLiveCarry(capture, "stdout", context.onTunnelOutput);
    flushLiveCarry(capture, "stderr", context.onTunnelOutput);
  });
}

export function getTunnelDiagnostics(child: ChildProcess): TunnelDiagnostics {
  const capture = tunnelCaptures.get(child);
  if (capture === undefined) {
    return {
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }
  return {
    stdout: safeOutputText(
      capture.stdout,
      capture.redaction,
      capture.outputLimit,
      "tail",
    ),
    stderr: safeOutputText(
      capture.stderr,
      capture.redaction,
      capture.outputLimit,
      "tail",
    ),
    stdoutTruncated: capture.stdout.truncated,
    stderrTruncated: capture.stderr.truncated,
  };
}

export function formatTunnelDiagnostics(
  diagnostics: TunnelDiagnostics,
): string | undefined {
  const sections: string[] = [];
  const stdout = diagnostics.stdout.trim();
  const stderr = diagnostics.stderr.trim();
  if (stdout.length > 0) {
    sections.push(`[tunnel stdout]\n${stdout}`);
  }
  if (diagnostics.stdoutTruncated) {
    sections.push("[tunnel stdout tail was truncated]");
  }
  if (stderr.length > 0) {
    sections.push(`[tunnel stderr]\n${stderr}`);
  }
  if (diagnostics.stderrTruncated) {
    sections.push("[tunnel stderr tail was truncated]");
  }
  return sections.length === 0 ? undefined : sections.join("\n");
}

export function spawnSshTunnel(
  appName: string,
  localPort: number,
  remotePort: number,
  context: CfExecContext,
  target: NodeTargetSelectors = {},
): ReturnType<typeof spawn> {
  if (context.signal?.aborted || isDeadlineExpired(context)) {
    throw sshAbortError(context);
  }
  const tunnelArg = `${localPort.toString()}:localhost:${remotePort.toString()}`;
  const args = buildCfSshArgs(appName, target, ["-N", "-L", tunnelArg]);
  const child = spawn(resolveBin(context), [...args], {
    env: buildEnv(context.cfHome),
    detached: nodeProcess.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  attachTunnelCapture(child, context);
  return child;
}
