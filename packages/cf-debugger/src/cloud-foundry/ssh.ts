import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import nodeProcess from "node:process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import {
  buildEnv,
  redactSensitiveText,
  resolveBin,
  type CfExecContext,
} from "./execute.js";
import type { NodeTargetSelectors } from "./node-process.js";
import {
  appendTail,
  buildCfSshArgs,
  createBoundedOutput,
  createRedactionPolicy,
  DEFAULT_MAX_OUTPUT_BYTES,
  isDeadlineExpired,
  LIVE_LINE_LIMIT_BYTES,
  safeOutputText,
  SENSITIVE_OUTPUT_OMITTED,
  sshAbortError,
  type BoundedOutput,
  type RedactionPolicy,
} from "./ssh-shared.js";

export {
  cfSshOneShot,
} from "./ssh-one-shot.js";
export type {
  CfSshOptions,
  CfSshSignalResult,
} from "./ssh-one-shot.js";
export { buildCfSshArgs } from "./ssh-shared.js";

export interface TunnelDiagnostics {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
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
