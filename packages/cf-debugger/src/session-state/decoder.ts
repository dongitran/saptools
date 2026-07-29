import { isAbsolute } from "node:path";

import { resolveNodeTarget } from "../cloud-foundry/node-process.js";
import { MAX_STARTUP_TIMEOUT_MS } from "../debug-session/constants.js";
import { isSafeSessionId } from "../paths.js";
import type { ActiveSession, SessionStatus, StateFile } from "../types.js";

const INVALID_SESSION = new Error("Invalid persisted debugger session");
const VALID_STATUSES: ReadonlySet<string> = new Set<SessionStatus>([
  "starting",
  "logging-in",
  "targeting",
  "ssh-enabling",
  "ssh-restarting",
  "signaling",
  "tunneling",
  "ready",
  "stopping",
  "stopped",
  "error",
]);

export interface StateDecodeSuccess {
  readonly kind: "decoded";
  readonly state: StateFile;
  readonly dropped: readonly string[];
}

export interface StateDecodeFailure {
  readonly kind: "invalid-file";
  readonly reason: string;
}

export type StateDecodeResult = StateDecodeFailure | StateDecodeSuccess;

function field(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function requireString(value: object, key: string): string {
  const candidate = field(value, key);
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw INVALID_SESSION;
  }
  return candidate;
}

function optionalString(value: object, key: string): string | undefined {
  const candidate = field(value, key);
  if (candidate === undefined) {
    return undefined;
  }
  if (typeof candidate !== "string") {
    throw INVALID_SESSION;
  }
  return candidate;
}

function optionalNonEmptyString(value: object, key: string): string | undefined {
  const candidate = optionalString(value, key);
  if (candidate?.length === 0) {
    throw INVALID_SESSION;
  }
  return candidate;
}

function requireInteger(
  value: object,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const candidate = field(value, key);
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw INVALID_SESSION;
  }
  return candidate;
}

function optionalInteger(
  value: object,
  key: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const candidate = field(value, key);
  if (candidate === undefined) {
    return undefined;
  }
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw INVALID_SESSION;
  }
  return candidate;
}

function requireSessionId(value: object): string {
  const sessionId = requireString(value, "sessionId");
  if (!isSafeSessionId(sessionId)) {
    throw INVALID_SESSION;
  }
  return sessionId;
}

function requireAbsolutePath(value: object, key: string): string {
  const path = requireString(value, key);
  if (!isAbsolute(path)) {
    throw INVALID_SESSION;
  }
  return path;
}

function requireTimestamp(value: object): string {
  const timestamp = requireString(value, "startedAt");
  if (Number.isNaN(Date.parse(timestamp))) {
    throw INVALID_SESSION;
  }
  return timestamp;
}

function optionalTimestamp(value: object, key: string): string | undefined {
  const timestamp = optionalString(value, key);
  if (timestamp !== undefined && Number.isNaN(Date.parse(timestamp))) {
    throw INVALID_SESSION;
  }
  return timestamp;
}

function isSessionStatus(value: string): value is SessionStatus {
  return VALID_STATUSES.has(value);
}

function requireStatus(value: object): SessionStatus {
  const status = requireString(value, "status");
  if (!isSessionStatus(status)) {
    throw INVALID_SESSION;
  }
  return status;
}

function optionalFields(value: object): Pick<
  ActiveSession,
  "controllerProcessIdentity" | "startupTimeoutMs" | "tunnelProcessIdentity"
> {
  const controllerProcessIdentity = optionalNonEmptyString(value, "controllerProcessIdentity");
  const tunnelProcessIdentity = optionalNonEmptyString(value, "tunnelProcessIdentity");
  const startupTimeoutMs = optionalInteger(value, "startupTimeoutMs", 1, MAX_STARTUP_TIMEOUT_MS);
  return {
    ...(controllerProcessIdentity === undefined ? {} : { controllerProcessIdentity }),
    ...(tunnelProcessIdentity === undefined ? {} : { tunnelProcessIdentity }),
    ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
  };
}

function decodeTarget(value: object): ReturnType<typeof resolveNodeTarget> {
  const nodePid = optionalInteger(value, "nodePid", 1);
  return resolveNodeTarget({
    process: requireString(value, "process"),
    instance: requireInteger(value, "instance", 0, Number.MAX_SAFE_INTEGER),
    ...(nodePid === undefined ? {} : { nodePid }),
  });
}

export function decodeSession(value: unknown): ActiveSession | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  try {
    const target = decodeTarget(value);
    const pid = requireInteger(value, "pid", 1, Number.MAX_SAFE_INTEGER);
    const tunnelPid = optionalInteger(value, "tunnelPid", 1);
    const controllerPid = optionalInteger(value, "controllerPid", 1) ?? pid;
    const remoteNodePid = optionalInteger(value, "remoteNodePid", 1);
    const stopRequestedAt = optionalTimestamp(value, "stopRequestedAt");
    const message = optionalString(value, "message");
    const status = requireStatus(value);
    if (pid !== (tunnelPid ?? controllerPid) || (status === "ready" && tunnelPid === undefined)) {
      throw INVALID_SESSION;
    }
    return {
      sessionId: requireSessionId(value),
      pid,
      controllerPid,
      ...optionalFields(value),
      ...(tunnelPid === undefined ? {} : { tunnelPid }),
      hostname: requireString(value, "hostname"),
      region: requireString(value, "region"),
      org: requireString(value, "org"),
      space: requireString(value, "space"),
      app: requireString(value, "app"),
      process: target.process,
      instance: target.instance,
      ...(target.nodePid === undefined ? {} : { nodePid: target.nodePid }),
      apiEndpoint: requireString(value, "apiEndpoint"),
      localPort: requireInteger(value, "localPort", 1, 65_535),
      remotePort: requireInteger(value, "remotePort", 1, 65_535),
      cfHomeDir: requireAbsolutePath(value, "cfHomeDir"),
      startedAt: requireTimestamp(value),
      status,
      ...(remoteNodePid === undefined ? {} : { remoteNodePid }),
      ...(stopRequestedAt === undefined ? {} : { stopRequestedAt }),
      ...(message === undefined ? {} : { message }),
    };
  } catch {
    return undefined;
  }
}

interface DecodedSessions {
  readonly dropped: readonly string[];
  readonly sessions: readonly ActiveSession[];
}

function decodeSessions(rawSessions: readonly unknown[]): DecodedSessions {
  const seen = new Set<string>();
  const sessions: ActiveSession[] = [];
  const dropped: string[] = [];
  for (const [index, raw] of rawSessions.entries()) {
    const session = decodeSession(raw);
    if (session === undefined) {
      dropped.push(`session[${index.toString()}]: invalid entry`);
      continue;
    }
    if (seen.has(session.sessionId)) {
      dropped.push(`session[${index.toString()}]: duplicate sessionId ${session.sessionId}`);
      continue;
    }
    seen.add(session.sessionId);
    sessions.push(session);
  }
  return { dropped, sessions };
}

export function decodeStateFileDetailed(value: unknown): StateDecodeResult {
  if (typeof value !== "object" || value === null) {
    return { kind: "invalid-file", reason: "root is not an object" };
  }
  if (field(value, "version") !== "2") {
    return { kind: "invalid-file", reason: "unsupported or missing version" };
  }
  const rawSessions = field(value, "sessions");
  if (!Array.isArray(rawSessions)) {
    return { kind: "invalid-file", reason: "sessions is not an array" };
  }
  const decoded = decodeSessions(rawSessions);
  return {
    kind: "decoded",
    state: { version: "2", sessions: decoded.sessions },
    dropped: decoded.dropped,
  };
}

export function decodeStateFile(value: unknown): StateFile | undefined {
  const result = decodeStateFileDetailed(value);
  return result.kind === "decoded" ? result.state : undefined;
}
