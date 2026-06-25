import process from "node:process";

import type { LiveTraceEvent, LiveTraceStateEvent } from "../types.js";

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function writeProgress(event: LiveTraceStateEvent): void {
  process.stderr.write(`[cf-live-trace] ${event.state}: ${event.message}\n`);
}

export function writeLog(message: string): void {
  process.stderr.write(`[cf-live-trace] ${message}\n`);
}

export function writeSummaryLine(event: LiveTraceEvent): void {
  const status = event.status === null ? "-" : String(event.status);
  const duration = event.durationMs === null ? "-" : `${event.durationMs.toString()}ms`;
  process.stdout.write(`${event.timestamp} ${event.method} ${event.normalizedUrl} ${status} ${duration}\n`);
}
