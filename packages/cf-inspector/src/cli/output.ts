import process from "node:process";

import type { LogpointEvent } from "../logpoint/events.js";
import type { SnapshotResult } from "../types.js";

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
  if (snapshot.topFrame) {
    appendFrameLines(lines, snapshot);
  }
  if (snapshot.captures.length > 0) {
    lines.push("  captures:");
    for (const capture of snapshot.captures) {
      const detail = capture.error ?? capture.value ?? "undefined";
      lines.push(`    ${capture.expression} = ${detail}`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function appendFrameLines(lines: string[], snapshot: SnapshotResult): void {
  const frame = snapshot.topFrame;
  if (frame === undefined) {
    return;
  }
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
