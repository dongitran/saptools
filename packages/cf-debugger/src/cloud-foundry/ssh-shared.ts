import { CfDebuggerError } from "../types.js";

import {
  normalizeSensitiveValues,
  redactSensitiveText,
  type CfExecContext,
} from "./execute.js";
import {
  DEFAULT_CF_PROCESS,
  resolveNodeTarget,
  type NodeTargetSelectors,
} from "./node-process.js";

export const DEFAULT_MAX_OUTPUT_BYTES = 65_536;
export const LIVE_LINE_LIMIT_BYTES = 65_536;
const MAX_REDACTION_OVERLAP_BYTES = 4096;
export const SENSITIVE_OUTPUT_OMITTED =
  "[diagnostic output omitted to protect a sensitive value]";

export interface BoundedOutput {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

export interface RedactionPolicy {
  readonly safeToSurface: boolean;
  readonly sensitiveValues: readonly string[];
  readonly overlapBytes: number;
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

export function createBoundedOutput(): BoundedOutput {
  return { chunks: [], bytes: 0, truncated: false };
}

export function appendHead(
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

export function appendTail(
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

export function createRedactionPolicy(values: readonly string[]): RedactionPolicy {
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

function outputText(output: BoundedOutput): string {
  return Buffer.concat(output.chunks, output.bytes).toString("utf8");
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

export function safeOutputText(
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

export function sshAbortError(context: CfExecContext): CfDebuggerError {
  if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt) {
    return new CfDebuggerError(
      "STARTUP_TIMEOUT",
      `Debugger startup exceeded its configured deadline during ${context.phase ?? "remote signalling"}.`,
    );
  }
  return new CfDebuggerError("ABORTED", "Operation aborted by caller");
}

export function isDeadlineExpired(context: CfExecContext): boolean {
  return context.deadlineAt !== undefined && Date.now() >= context.deadlineAt;
}
