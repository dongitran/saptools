import type { AppCrashSummary, AuditEvent, CrashRecord, CrashSummary, SpaceCrashSummary } from "./types.js";
import { CRASH_EVENT_TYPES, SSH_EVENT_TYPES } from "./types.js";

const DURATION_PATTERN = /^(\d+)\s*(s|m|h|d)$/;

const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function isCrashEvent(event: AuditEvent): boolean {
  return (CRASH_EVENT_TYPES as readonly string[]).includes(event.type);
}

export function isSshEvent(event: AuditEvent): boolean {
  return (SSH_EVENT_TYPES as readonly string[]).includes(event.type);
}

export function filterByTypes(
  events: readonly AuditEvent[],
  types: readonly string[],
): readonly AuditEvent[] {
  if (types.length === 0) {
    return events;
  }
  const allowed = new Set(types);
  return events.filter((event) => allowed.has(event.type));
}

export function sortEventsNewestFirst(events: readonly AuditEvent[]): readonly AuditEvent[] {
  return [...events].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** Parses a human duration such as `30m`, `6h`, or `7d` into milliseconds. */
export function parseDuration(raw: string): number {
  const match = DURATION_PATTERN.exec(raw.trim().toLowerCase());
  const amountToken = match?.[1];
  const unitToken = match?.[2];
  if (amountToken === undefined || unitToken === undefined) {
    throw new Error(`Invalid duration "${raw}". Use forms like 30m, 6h, or 7d.`);
  }

  const amount = Number.parseInt(amountToken, 10);
  const unitMs = DURATION_UNIT_MS[unitToken];
  if (unitMs === undefined || amount <= 0) {
    throw new Error(`Invalid duration "${raw}". Use forms like 30m, 6h, or 7d.`);
  }
  return amount * unitMs;
}

/** Converts a duration into an ISO timestamp suitable for `created_ats[gt]`. */
export function durationToCreatedAfter(raw: string, now: Date): string {
  return new Date(now.getTime() - parseDuration(raw)).toISOString();
}

/**
 * Parses a comma-separated `--type` filter. Accepts the shorthands `ssh` and
 * `crash`, or any full Cloud Foundry event type (e.g. `audit.app.start`).
 */
export function parseTypeFilter(raw: string | undefined): readonly string[] {
  if (raw === undefined) {
    return [];
  }

  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const resolved: string[] = [];
  for (const token of tokens) {
    if (token === "ssh") {
      resolved.push(...SSH_EVENT_TYPES);
    } else if (token === "crash") {
      resolved.push(...CRASH_EVENT_TYPES);
    } else if (token.startsWith("audit.") || token.startsWith("app.")) {
      resolved.push(token);
    } else {
      throw new Error(
        `Unknown event type "${token}". Use a full CF event type ` +
          '(e.g. audit.app.start) or the shorthand "ssh"/"crash".',
      );
    }
  }
  return [...new Set(resolved)];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function toCrashRecord(event: AuditEvent): CrashRecord {
  return {
    at: event.createdAt,
    index: readNumber(event.data["index"]),
    reason: readString(event.data["reason"]) ?? readString(event.data["exit_description"]),
    exitStatus: readNumber(event.data["exit_status"]),
  };
}

export function summarizeCrashes(appName: string, events: readonly AuditEvent[]): CrashSummary {
  const crashes = events
    .filter(isCrashEvent)
    .map(toCrashRecord)
    .sort((left, right) => right.at.localeCompare(left.at));
  const last = crashes[0];
  return {
    appName,
    crashCount: crashes.length,
    lastCrashAt: last?.at,
    lastCrashReason: last?.reason,
    crashes,
  };
}


function crashAppName(event: AuditEvent): string {
  if (event.target.name.length > 0) {
    return event.target.name;
  }
  if (event.target.guid.length > 0) {
    return event.target.guid;
  }
  return "(unknown app)";
}

export function summarizeSpaceCrashes(
  selector: string,
  events: readonly AuditEvent[],
): SpaceCrashSummary {
  const byApp = new Map<string, AuditEvent[]>();
  for (const event of events.filter(isCrashEvent)) {
    const appName = crashAppName(event);
    byApp.set(appName, [...(byApp.get(appName) ?? []), event]);
  }

  const apps: AppCrashSummary[] = [...byApp.entries()]
    .map(([appName, appEvents]) => summarizeCrashes(appName, appEvents))
    .map(({ appName, crashCount, lastCrashAt, lastCrashReason, crashes }) => ({
      appName,
      crashCount,
      lastCrashAt,
      lastCrashReason,
      crashes,
    }))
    .sort((left, right) => {
      const byTime = (right.lastCrashAt ?? "").localeCompare(left.lastCrashAt ?? "");
      return byTime === 0 ? left.appName.localeCompare(right.appName) : byTime;
    });

  return {
    scope: "space",
    selector,
    crashCount: apps.reduce((sum, app) => sum + app.crashCount, 0),
    lastCrashAt: apps[0]?.lastCrashAt,
    apps,
  };
}
