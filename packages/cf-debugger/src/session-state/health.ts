import { hostname as getHostname } from "node:os";
import nodeProcess from "node:process";

import {
  inspectRecordedProcess,
  startupExpired,
} from "../debug-session/session-process.js";
import { inspectPortOwnership } from "../port.js";
import type { ActiveSession } from "../types.js";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

export function isPidAlive(pid: number): boolean {
  try {
    nodeProcess.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) !== "ESRCH";
  }
}

export function isProcessGroupAlive(pid: number): boolean {
  return nodeProcess.platform !== "win32" && isPidAlive(-pid);
}

export function isPidOrGroupAlive(pid: number): boolean {
  return isPidAlive(pid) || isProcessGroupAlive(pid);
}

export type SessionHealthStatus = "healthy" | "stale" | "unverified";

export interface SessionHealthVerdict {
  readonly status: SessionHealthStatus;
  readonly reason: string;
}

async function readySessionHealth(
  session: ActiveSession,
  signal?: AbortSignal,
): Promise<SessionHealthVerdict> {
  const tunnelPid = session.tunnelPid;
  if (tunnelPid === undefined) {
    return { status: "stale", reason: "recorded tunnel PID is missing" };
  }
  const processVerdict = await inspectRecordedProcess(
    tunnelPid,
    session.tunnelProcessIdentity,
    isPidAlive,
    signal,
  );
  if (processVerdict === "dead" && isProcessGroupAlive(tunnelPid)) {
    return {
      status: "unverified",
      reason: "tunnel leader exited while its process group is still alive",
    };
  }
  if (processVerdict === "dead" || processVerdict === "mismatch") {
    return { status: "stale", reason: "recorded tunnel process is gone or was reused" };
  }
  if (processVerdict === "unavailable") {
    return { status: "unverified", reason: "recorded tunnel identity could not be inspected" };
  }
  const ownership = await inspectPortOwnership(session.localPort, tunnelPid, signal);
  if (ownership.status === "owned") {
    return { status: "healthy", reason: "recorded tunnel owns the local port" };
  }
  if (ownership.status === "unverified") {
    return { status: "unverified", reason: ownership.reason };
  }
  return {
    status: "unverified",
    reason: ownership.status === "not-owned"
      ? `recorded live tunnel no longer owns the local port; observed PID(s) ${ownership.pids.join(", ")}`
      : "recorded live tunnel no longer has a listening local port",
  };
}

async function startingSessionHealth(
  session: ActiveSession,
  signal?: AbortSignal,
): Promise<SessionHealthVerdict> {
  if (startupExpired(session)) {
    if (session.tunnelPid !== undefined) {
      return await readySessionHealth(session, signal);
    }
    return { status: "stale", reason: "startup exceeded its maximum supported age" };
  }
  const controllerPid = session.controllerPid ?? session.pid;
  const processVerdict = await inspectRecordedProcess(
    controllerPid,
    session.controllerProcessIdentity,
    isPidAlive,
    signal,
  );
  if (processVerdict === "match") {
    return { status: "healthy", reason: "startup controller identity matches" };
  }
  if (processVerdict === "unavailable") {
    return { status: "unverified", reason: "startup controller identity could not be inspected" };
  }
  if (session.tunnelPid === undefined) {
    return { status: "stale", reason: "startup controller is gone or was reused" };
  }
  return await readySessionHealth(session, signal);
}

export async function inspectSessionHealth(
  session: ActiveSession,
  host = getHostname(),
  signal?: AbortSignal,
): Promise<SessionHealthVerdict> {
  if (session.hostname !== host) {
    return { status: "stale", reason: "session belongs to another host" };
  }
  return session.status === "ready"
    ? await readySessionHealth(session, signal)
    : await startingSessionHealth(session, signal);
}

export async function filterStaleSessions(
  sessions: readonly ActiveSession[],
  signal?: AbortSignal,
): Promise<readonly ActiveSession[]> {
  const host = getHostname();
  const verdicts = await Promise.all(
    sessions.map(async (session): Promise<readonly [ActiveSession, SessionHealthVerdict]> => [
      session,
      await inspectSessionHealth(session, host, signal),
    ]),
  );
  return verdicts
    .filter(([, verdict]) => verdict.status !== "stale")
    .map(([session]) => session);
}
