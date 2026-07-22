import process from "node:process";

import type { LogpointEvent } from "../logpoint/events.js";
import type { ExceptionSnapshot, FrameSnapshot, SnapshotResult, WatchEvent } from "../types.js";

interface TruncationSummary {
  readonly truncated?: true;
  readonly originalLength?: number;
  readonly omittedCount?: number;
}

export function writeProgress(message: string): void {
  process.stderr.write(`[cf-inspector] ${message}\n`);
}

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
    `  isolate: ${formatIsolate(snapshot.isolate)}`,
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
      lines.push(`    ${capture.expression} = ${renderTruncated(detail, capture)}`);
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
  if (frame.truncated === true) {
    lines.push(`  scopes:  ${truncationLabel(frame)}`);
  }
  if (frame.scopes === undefined) {
    return;
  }
  for (const scope of frame.scopes) {
    const scopeSuffix = scope.truncated === true ? `; ${truncationLabel(scope)}` : "";
    lines.push(`  scope ${scope.type} (${scope.variables.length.toString()} vars${scopeSuffix}):`);
    for (const variable of scope.variables) {
      lines.push(`    ${variable.name} = ${renderTruncated(variable.value, variable)}`);
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
      lines.push(`      ${capture.expression} = ${renderTruncated(detail, capture)}`);
    }
  }
}

function appendExceptionLines(lines: string[], exception: ExceptionSnapshot): void {
  if (exception.error !== undefined) {
    lines.push(`  exception: !err ${exception.error}`);
    return;
  }
  lines.push(`  exception: ${renderExceptionDetail(exception)}`);
}

export function writeLogEvent(event: LogpointEvent, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  const isolateSuffix = event.isolate === undefined ? "" : ` (${formatIsolate(event.isolate)})`;
  if (event.error !== undefined) {
    process.stdout.write(`[${event.ts}] ${event.at}${isolateSuffix} !err ${renderTruncated(event.error, event)}\n`);
    return;
  }
  process.stdout.write(`[${event.ts}] ${event.at}${isolateSuffix} ${renderTruncated(event.value ?? "", event)}\n`);
}

export function writeWatchEvent(event: WatchEvent, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  process.stdout.write(
    `[${event.ts}] hit#${event.hit.toString()} ${event.at} (${formatIsolate(event.isolate)})\n`,
  );
  if (event.exception !== undefined) {
    process.stdout.write(`  exception: ${renderExceptionDetail(event.exception)}\n`);
  }
  for (const capture of event.captures) {
    const detail = capture.error ?? capture.value ?? "undefined";
    process.stdout.write(`  ${capture.expression} = ${renderTruncated(detail, capture)}\n`);
  }
}

function formatIsolate(isolate: SnapshotResult["isolate"]): string {
  if (isolate?.kind === "worker") {
    return `worker ${isolate.workerId}`;
  }
  return "main";
}

function renderExceptionDetail(exception: ExceptionSnapshot): string {
  if (exception.description !== undefined) {
    const originalLength = exception.descriptionOriginalLength;
    return renderTruncated(
      exception.description,
      originalLength === undefined ? {} : { truncated: true, originalLength },
    );
  }
  if (exception.value !== undefined) {
    const originalLength = exception.valueOriginalLength ?? exception.originalLength;
    const summary: TruncationSummary = {
      ...(originalLength === undefined ? {} : { truncated: true, originalLength }),
      ...(exception.omittedCount === undefined
        ? {}
        : { truncated: true, omittedCount: exception.omittedCount }),
    };
    return renderTruncated(exception.value, summary);
  }
  return exception.error ?? "(unknown)";
}

function renderTruncated(value: string, summary: TruncationSummary): string {
  if (summary.truncated !== true) {
    return value;
  }
  const visualValue = summary.originalLength === undefined ? value : `${value}…`;
  return `${visualValue} [${truncationLabel(summary)}]`;
}

function truncationLabel(summary: TruncationSummary): string {
  const details: string[] = [];
  if (summary.originalLength !== undefined) {
    details.push(`original ${summary.originalLength.toString()} chars`);
  }
  if (summary.omittedCount !== undefined) {
    details.push(`${summary.omittedCount.toString()} omitted`);
  }
  return details.length === 0 ? "truncated" : `truncated: ${details.join(", ")}`;
}
