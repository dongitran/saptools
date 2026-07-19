import { rm } from "node:fs/promises";
import { hostname as getHostname } from "node:os";
import process from "node:process";

import { isOwnedSessionCfHomeDir } from "../paths.js";
import { findListeningProcessId, isPortListening } from "../port.js";
import {
  isPidAlive,
  isPidOrGroupAlive,
  matchesKey,
  readActiveSessions,
  readSessionSnapshot,
  removeSession,
  requestSessionStop,
} from "../state.js";
import type { ActiveSession, SessionKey } from "../types.js";
import { CfDebuggerError } from "../types.js";

import { terminatePidOrGroup, type TerminationOutcome } from "./processes.js";

export interface StopOptions {
  readonly sessionId?: string;
  readonly key?: SessionKey;
}

export interface StopDebuggerResult extends ActiveSession {
  readonly stale: boolean;
  readonly pending: boolean;
}

function findMatchingSession(
  sessions: readonly ActiveSession[],
  options: StopOptions,
): ActiveSession | undefined {
  if (options.sessionId !== undefined) {
    return sessions.find((s) => s.sessionId === options.sessionId);
  }
  if (options.key !== undefined) {
    const key = options.key;
    const matches = sessions.filter((session) => matchesKey(session, key));
    if (matches.length > 1) {
      throw new CfDebuggerError(
        "SESSION_AMBIGUOUS",
        "Multiple debugger sessions match this target. Pass an exact session ID, API endpoint, or Node PID.",
      );
    }
    return matches[0];
  }
  return undefined;
}

async function ownsRecordedTunnel(target: ActiveSession): Promise<boolean> {
  if (target.tunnelPid === undefined || !(await isPortListening(target.localPort))) {
    return false;
  }
  return await findListeningProcessId(target.localPort) === target.tunnelPid;
}

async function terminateVerifiedTunnel(target: ActiveSession): Promise<TerminationOutcome> {
  if (target.tunnelPid !== undefined && target.tunnelPid !== process.pid) {
    try {
      return await terminatePidOrGroup(target.tunnelPid);
    } catch {
      return "still-alive";
    }
  }
  return target.tunnelPid === process.pid ? "still-alive" : "terminated";
}

async function terminateVerifiedTunnelAndConfirm(target: ActiveSession): Promise<void> {
  const termination = await terminateVerifiedTunnel(target);
  if (termination === "still-alive" || await ownsRecordedTunnel(target)) {
    throw new CfDebuggerError(
      "TUNNEL_TERMINATION_FAILED",
      `Tunnel process for session ${target.sessionId} did not terminate; state was retained.`,
    );
  }
}

async function cleanupOwnedCfHome(target: ActiveSession, locallyOwned: boolean): Promise<void> {
  if (locallyOwned && isOwnedSessionCfHomeDir(target.sessionId, target.cfHomeDir)) {
    try {
      await rm(target.cfHomeDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

async function removeOwnedSession(
  target: ActiveSession,
  stale: boolean,
): Promise<StopDebuggerResult> {
  const removed = await removeSession(target.sessionId);
  await cleanupOwnedCfHome(target, true);
  return { ...(removed ?? target), stale, pending: false };
}

function ownershipError(target: ActiveSession): CfDebuggerError {
  return new CfDebuggerError(
    "TUNNEL_OWNERSHIP_UNVERIFIED",
    `Cannot safely stop session ${target.sessionId}: local tunnel ownership could not be verified.`,
  );
}

async function stopReadySession(target: ActiveSession): Promise<StopDebuggerResult> {
  if (await ownsRecordedTunnel(target)) {
    await terminateVerifiedTunnelAndConfirm(target);
    return await removeOwnedSession(target, false);
  }
  const tunnelDead = target.tunnelPid !== undefined && !isPidOrGroupAlive(target.tunnelPid);
  if (tunnelDead && !(await isPortListening(target.localPort))) {
    return await removeOwnedSession(target, true);
  }
  throw ownershipError(target);
}

async function stopStartingSession(target: ActiveSession): Promise<StopDebuggerResult> {
  if (
    target.status === "stopping" &&
    target.tunnelPid !== undefined &&
    !isPidOrGroupAlive(target.tunnelPid) &&
    !(await isPortListening(target.localPort))
  ) {
    return await removeOwnedSession(target, true);
  }
  if (isPidAlive(target.controllerPid ?? target.pid)) {
    return { ...target, stale: false, pending: true };
  }
  if (await ownsRecordedTunnel(target)) {
    await terminateVerifiedTunnelAndConfirm(target);
    return await removeOwnedSession(target, false);
  }
  const tunnelAlive = target.tunnelPid !== undefined && isPidOrGroupAlive(target.tunnelPid);
  if (!tunnelAlive && !(await isPortListening(target.localPort))) {
    return await removeOwnedSession(target, true);
  }
  throw ownershipError(target);
}

export async function stopDebugger(options: StopOptions): Promise<StopDebuggerResult | undefined> {
  const localSessions = (await readSessionSnapshot()).filter(
    (session) => session.hostname === getHostname(),
  );
  const target = findMatchingSession(localSessions, options);
  if (target === undefined) {
    return undefined;
  }
  const claim = await requestSessionStop(target.sessionId);
  if (claim === undefined) {
    return undefined;
  }
  return claim.previousStatus === "ready"
    ? await stopReadySession(claim.session)
    : await stopStartingSession(claim.session);
}

export async function stopAllDebuggers(): Promise<number> {
  const sessions = (await readSessionSnapshot()).filter(
    (session) => session.hostname === getHostname(),
  );
  let stopped = 0;
  for (const session of sessions) {
    const result = await stopDebugger({ sessionId: session.sessionId });
    if (result) {
      stopped += 1;
    }
  }
  return stopped;
}

export async function listSessions(): Promise<readonly ActiveSession[]> {
  return await readActiveSessions();
}

export async function getSession(key: SessionKey): Promise<ActiveSession | undefined> {
  const sessions = await readActiveSessions();
  return findMatchingSession(sessions, { key });
}
