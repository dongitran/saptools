import process from "node:process";

import type { LogpointEvent } from "../logpoint/events.js";
import type { ExceptionSnapshot, FrameSnapshot, SnapshotResult, WatchEvent } from "../types.js";

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeHumanSnapshot(snapshot: SnapshotResult): void {
  const pausedDuration = snapshot.pausedDurationMs === null
    ? "unknown"
    : `${snapshot.pausedDurationMs.toFixed(1)}ms`;
  const lines: string[] = [];
  lines.push(
    `Snapshot @ ${snapshot.capturedAt}`,
    `  reason:  ${snapshot.reason}`,
    `  paused:  ${pausedDuration}`,
  );
  if (snapshot.exception !== undefined) {
    appendExceptionLines(lines, snapshot.exception);
  }
  if (snapshot.topFrame) {
    appendFrameLines(lines, snapshot.topFrame);
  }
  if (snapshot.captures.length > 0) {
    lines.push("  captures:");
    for (const capture of snapshot.captures) {
      const detail = capture.error ?? capture.value ?? "undefined";
      lines.push(`    ${capture.expression} = ${detail}`);
    }
  }
  if (snapshot.stack !== undefined && snapshot.stack.length > 0) {
    lines.push("  stack:");
    for (const frame of snapshot.stack) {
      appendStackFrameLine(lines, frame);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function appendFrameLines(lines: string[], frame: FrameSnapshot): void {
  const fnName = frame.functionName.length === 0 ? "(anonymous)" : frame.functionName;
  const sourceUrl = frame.url !== undefined && frame.url.length > 0 ? frame.url : "(unknown)";
  lines.push(
    `  frame:   ${fnName} ${sourceUrl}:${frame.line.toString()}:${frame.column.toString()}`,
  );
  if (frame.scopes === undefined) {
    return;
  }
  for (const scope of frame.scopes) {
    lines.push(`  scope ${scope.type} (${scope.variables.length.toString()} vars):`);
    for (const variable of scope.variables) {
      lines.push(`    ${variable.name} = ${variable.value}`);
    }
  }
}

function appendStackFrameLine(lines: string[], frame: FrameSnapshot): void {
  const fnName = frame.functionName.length === 0 ? "(anonymous)" : frame.functionName;
  const sourceUrl = frame.url !== undefined && frame.url.length > 0 ? frame.url : "(unknown)";
  lines.push(`    ${fnName} ${sourceUrl}:${frame.line.toString()}:${frame.column.toString()}`);
  if (frame.captures !== undefined) {
    for (const capture of frame.captures) {
      const detail = capture.error ?? capture.value ?? "undefined";
      lines.push(`      ${capture.expression} = ${detail}`);
    }
  }
}

function appendExceptionLines(lines: string[], exception: ExceptionSnapshot): void {
  if (exception.error !== undefined) {
    lines.push(`  exception: !err ${exception.error}`);
    return;
  }
  const detail = exception.description ?? exception.value ?? "(unknown)";
  lines.push(`  exception: ${detail}`);
}

export function writeLogEvent(event: LogpointEvent, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  if (event.error !== undefined) {
    process.stdout.write(`[${event.ts}] ${event.at} !err ${event.error}\n`);
    return;
  }
  process.stdout.write(`[${event.ts}] ${event.at} ${event.value ?? ""}\n`);
}

export function writeWatchEvent(event: WatchEvent, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  process.stdout.write(`[${event.ts}] hit#${event.hit.toString()} ${event.at}\n`);
  if (event.exception !== undefined) {
    const detail = event.exception.description ?? event.exception.value ?? event.exception.error ?? "(unknown)";
    process.stdout.write(`  exception: ${detail}\n`);
  }
  for (const capture of event.captures) {
    const detail = capture.error ?? capture.value ?? "undefined";
    process.stdout.write(`  ${capture.expression} = ${detail}\n`);
  }
}
