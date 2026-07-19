import { isAbsolute } from "node:path";

import { resolveNodeTarget } from "../cloud-foundry/node-process.js";
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

function requireInteger(value: object, key: string, minimum: number, maximum: number): number {
  const candidate = field(value, key);
  if (!Number.isSafeInteger(candidate) || typeof candidate !== "number") {
    throw INVALID_SESSION;
  }
  if (candidate < minimum || candidate > maximum) {
    throw INVALID_SESSION;
  }
  return candidate;
}

function optionalInteger(value: object, key: string, minimum: number): number | undefined {
  const candidate = field(value, key);
  if (candidate === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(candidate) || typeof candidate !== "number" || candidate < minimum) {
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

function decodeSession(value: unknown): ActiveSession | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  try {
    const processName = requireString(value, "process");
    const instance = requireInteger(value, "instance", 0, Number.MAX_SAFE_INTEGER);
    const nodePid = optionalInteger(value, "nodePid", 1);
    const target = resolveNodeTarget({
      process: processName,
      instance,
      ...(nodePid === undefined ? {} : { nodePid }),
    });
    const pid = requireInteger(value, "pid", 1, Number.MAX_SAFE_INTEGER);
    const controllerPid = requireInteger(value, "controllerPid", 1, Number.MAX_SAFE_INTEGER);
    const tunnelPid = optionalInteger(value, "tunnelPid", 1);
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
      ...(tunnelPid === undefined ? {} : { tunnelPid }),
      hostname: requireString(value, "hostname"),
      region: requireString(value, "region"),
      org: requireString(value, "org"),
      space: requireString(value, "space"),
      app: requireString(value, "app"),
      process: target.process,
      instance: target.instance,
      ...(nodePid === undefined ? {} : { nodePid }),
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

export function decodeStateFile(value: unknown): StateFile | undefined {
  if (typeof value !== "object" || value === null || field(value, "version") !== "2") {
    return undefined;
  }
  const rawSessions = field(value, "sessions");
  if (!Array.isArray(rawSessions)) {
    return undefined;
  }
  const sessionIds = new Set<string>();
  const sessions: ActiveSession[] = [];
  for (const rawSession of rawSessions) {
    const session = decodeSession(rawSession);
    if (session === undefined || sessionIds.has(session.sessionId)) {
      return undefined;
    }
    sessionIds.add(session.sessionId);
    sessions.push(session);
  }
  return { version: "2", sessions };
}
