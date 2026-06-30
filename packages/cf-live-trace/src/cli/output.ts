import process from "node:process";

import type { LiveTraceStateEvent } from "../types.js";

interface SummaryWritableEvent {
  readonly timestamp: string;
  readonly method: string;
  readonly normalizedUrl: string;
  readonly status: number | null;
  readonly durationMs: number | null;
  readonly sessionId?: string;
  readonly requestId?: string;
}

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

export function writeSummaryLine(event: SummaryWritableEvent): void {
  const status = event.status === null ? "-" : String(event.status);
  const duration = event.durationMs === null ? "-" : `${event.durationMs.toString()}ms`;
  const request = event.sessionId === undefined || event.requestId === undefined
    ? ""
    : ` ${event.sessionId}/${event.requestId}`;
  process.stdout.write(`${event.timestamp} ${event.method} ${event.normalizedUrl} ${status} ${duration}${request}\n`);
}
