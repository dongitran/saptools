import { hostname as getHostname } from "node:os";
import nodeProcess from "node:process";

import { isOwnedSessionCfHomeDir } from "../paths.js";
import { inspectListeningProcesses, inspectPortOwnership } from "../port.js";
import {
  clearSessionStopIntent,
  isPidAlive,
  isPidOrGroupAlive,
  matchesKey,
  readActiveSessions,
  readSessionSnapshot,
  removeSession,
  requestSessionStop,
  writeSessionStopIntent,
} from "../state.js";
import type { ActiveSession, SessionKey } from "../types.js";
import { CfDebuggerError } from "../types.js";

import {
  MAX_STARTUP_TIMEOUT_MS,
  STARTUP_STALE_SLACK_MS,
} from "./constants.js";
import { inspectProcessIdentity } from "./process-identity.js";
import type { ProcessIdentityVerdict } from "./process-identity.js";
import {
  terminatePidOrGroup,
  type TerminationOutcome,
  type TerminationVerifier,
} from "./processes.js";
import { removeOwnedSessionCfHome } from "./session-home.js";

export interface StopOptions {
  readonly sessionId?: string;
  readonly key?: SessionKey;
  readonly force?: boolean;
}

export interface StopDebuggerResult extends ActiveSession {
  readonly stale: boolean;
  readonly pending: boolean;
  readonly forced: boolean;
  readonly warning?: string;
}

export interface StopAllOutcome {
  readonly sessionId: string;
  readonly app: string;
  readonly status: "failed" | "pending" | "stale" | "stopped";
  readonly result?: StopDebuggerResult;
  readonly error?: CfDebuggerError;
}

export interface StopAllResult {
  readonly outcomes: readonly StopAllOutcome[];
  readonly failed: number;
  readonly pending: number;
  readonly stale: number;
  readonly stopped: number;
}

function findMatchingSession(
  sessions: readonly ActiveSession[],
  options: StopOptions,
): ActiveSession | undefined {
  if (options.sessionId !== undefined) {
    return sessions.find((session) => session.sessionId === options.sessionId);
  }
  if (options.key === undefined) {
    return undefined;
  }
  const key = options.key;
  const matches = sessions.filter((session) => matchesKey(session, key));
  if (matches.length > 1) {
    throw new CfDebuggerError(
      "SESSION_AMBIGUOUS",
      "Multiple debugger sessions match this target. Pass --session-id, --api-endpoint, or --node-pid.",
    );
  }
  return matches[0];
}

function startupAgeLimit(session: ActiveSession): number {
  return (session.startupTimeoutMs ?? MAX_STARTUP_TIMEOUT_MS) + STARTUP_STALE_SLACK_MS;
}

function startupExpired(session: ActiveSession): boolean {
  const startedAt = Date.parse(session.startedAt);
  return Number.isNaN(startedAt) || Date.now() - startedAt > startupAgeLimit(session);
}

type RecordedProcessVerdict = "dead" | ProcessIdentityVerdict;

async function inspectRecordedProcess(
  pid: number,
  identity: string | undefined,
): Promise<RecordedProcessVerdict> {
  if (!isPidAlive(pid)) {
    return "dead";
  }
  return await inspectProcessIdentity(pid, identity);
}

async function inspectController(target: ActiveSession): Promise<RecordedProcessVerdict> {
  const controllerPid = target.controllerPid ?? target.pid;
  return await inspectRecordedProcess(controllerPid, target.controllerProcessIdentity);
}

export async function ownsRecordedTunnel(target: ActiveSession): Promise<boolean> {
  const tunnelPid = target.tunnelPid;
  if (tunnelPid === undefined) {
    return false;
  }
  const processVerdict = await inspectRecordedProcess(
    tunnelPid,
    target.tunnelProcessIdentity,
  );
  if (processVerdict !== "match") {
    return false;
  }
  return (await inspectPortOwnership(target.localPort, tunnelPid)).status === "owned";
}

async function terminateVerifiedTunnel(target: ActiveSession): Promise<TerminationOutcome> {
  const tunnelPid = target.tunnelPid;
  if (tunnelPid === undefined || tunnelPid === nodeProcess.pid) {
    return tunnelPid === nodeProcess.pid ? "still-alive" : "terminated";
  }
  try {
    const verifyBeforeSignal: TerminationVerifier = async (signal): Promise<boolean> => {
      if (signal === "SIGTERM" || target.tunnelProcessIdentity === undefined) {
        return await ownsRecordedTunnel(target);
      }
      return await inspectRecordedProcess(
        tunnelPid,
        target.tunnelProcessIdentity,
      ) === "match";
    };
    return await terminatePidOrGroup(
      tunnelPid,
      undefined,
      undefined,
      verifyBeforeSignal,
    );
  } catch {
    return "still-alive";
  }
}

async function terminateVerifiedTunnelAndConfirm(
  target: ActiveSession,
  recordExpectedStop = false,
): Promise<void> {
  if (recordExpectedStop) {
    await writeSessionStopIntent(target.sessionId);
  }
  if (!(await ownsRecordedTunnel(target))) {
    throw ownershipError(target, "recorded tunnel no longer owns the local port");
  }
  const termination = await terminateVerifiedTunnel(target);
  if (termination !== "terminated" || await ownsRecordedTunnel(target)) {
    throw new CfDebuggerError(
      "TUNNEL_TERMINATION_FAILED",
      termination === "ownership-lost"
        ? `Tunnel ownership for session ${target.sessionId} could not be reverified during termination; ` +
          "no unverified process was signalled and state was retained."
        : `Tunnel process for session ${target.sessionId} did not terminate; state was retained.`,
    );
  }
}

async function removeOwnedSession(
  target: ActiveSession,
  stale: boolean,
  forced = false,
  warning?: string,
  preserveStopIntent = false,
): Promise<StopDebuggerResult> {
  let resultWarning = warning;
  if (isOwnedSessionCfHomeDir(target.sessionId, target.cfHomeDir)) {
    await removeOwnedSessionCfHome(target.sessionId, target.cfHomeDir);
  } else {
    const skipped = `State referenced unowned CF home ${target.cfHomeDir}; it was not deleted.`;
    resultWarning = resultWarning === undefined ? skipped : `${resultWarning} ${skipped}`;
  }
  const removed = await removeSession(target.sessionId);
  if (!preserveStopIntent) {
    await clearSessionStopIntent(target.sessionId);
  }
  return {
    ...(removed ?? target),
    stale,
    pending: false,
    forced,
    ...(resultWarning === undefined ? {} : { warning: resultWarning }),
  };
}

function ownershipError(target: ActiveSession, detail: string): CfDebuggerError {
  return new CfDebuggerError(
    "TUNNEL_OWNERSHIP_UNVERIFIED",
    `Cannot safely stop session ${target.sessionId}: ${detail}. ` +
      `No process was signalled. Retry with --force to forget the record and its owned CF home.`,
  );
}

function forcedWarning(target: ActiveSession, detail: string): string {
  return `Forced state cleanup abandoned PID ${String(target.tunnelPid ?? target.controllerPid ?? target.pid)} ` +
    `and local port ${target.localPort.toString()}: ${detail}. No unverified process was signalled.`;
}

async function forceRemoveUnverified(
  target: ActiveSession,
  detail: string,
  preserveStopIntent = false,
): Promise<StopDebuggerResult> {
  return await removeOwnedSession(
    target,
    true,
    true,
    forcedWarning(target, detail),
    preserveStopIntent,
  );
}

async function stopReadySession(
  target: ActiveSession,
  force: boolean,
): Promise<StopDebuggerResult> {
  if (await ownsRecordedTunnel(target)) {
    await terminateVerifiedTunnelAndConfirm(target, true);
    return await removeOwnedSession(target, false, false, undefined, true);
  }
  const tunnelVerdict = target.tunnelPid === undefined
    ? "dead"
    : await inspectRecordedProcess(target.tunnelPid, target.tunnelProcessIdentity);
  const tunnelDead = target.tunnelPid === undefined ||
    !isPidOrGroupAlive(target.tunnelPid) ||
    tunnelVerdict === "mismatch";
  const ownership = target.tunnelPid === undefined
    ? await inspectListeningProcesses(target.localPort)
    : await inspectPortOwnership(target.localPort, target.tunnelPid);
  if (tunnelDead && ownership.status === "not-listening") {
    return await removeOwnedSession(target, true, false, undefined, true);
  }
  const detail = ownership.status === "unverified"
    ? ownership.reason
    : ownership.status === "not-owned"
      ? `local port ${target.localPort.toString()} belongs to PID(s) ${ownership.pids.join(", ")}`
      : tunnelVerdict === "unavailable"
        ? "the recorded tunnel identity could not be inspected"
        : "the recorded tunnel could not be proven dead and owned";
  if (force) {
    return await forceRemoveUnverified(target, detail, true);
  }
  throw ownershipError(target, detail);
}

async function stopStartingSession(
  target: ActiveSession,
  force: boolean,
): Promise<StopDebuggerResult> {
  const expired = startupExpired(target);
  const controllerVerdict = await inspectController(target);
  if (!force && !expired && controllerVerdict === "match") {
    return { ...target, stale: false, pending: true, forced: false };
  }
  if (await ownsRecordedTunnel(target)) {
    await terminateVerifiedTunnelAndConfirm(target);
    return await removeOwnedSession(target, false, false, undefined, true);
  }
  const tunnelAlive = target.tunnelPid !== undefined && isPidOrGroupAlive(target.tunnelPid);
  const listening = await inspectListeningProcesses(target.localPort);
  const detail = listening.status === "unverified"
    ? listening.reason
    : listening.status === "found"
      ? `local port ${target.localPort.toString()} belongs to PID(s) ${listening.pids.join(", ")}`
      : controllerVerdict === "unavailable"
        ? "the startup controller identity could not be inspected"
        : "the recorded startup owner could not be verified as a tunnel";
  if (force) {
    return await forceRemoveUnverified(
      target,
      detail,
      controllerVerdict === "match",
    );
  }
  if (
    !tunnelAlive &&
    listening.status === "not-listening" &&
    (expired || controllerVerdict !== "unavailable")
  ) {
    return await removeOwnedSession(target, true);
  }
  throw ownershipError(target, detail);
}

export async function stopDebugger(
  options: StopOptions,
): Promise<StopDebuggerResult | undefined> {
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
    ? await stopReadySession(claim.session, options.force === true)
    : await stopStartingSession(claim.session, options.force === true);
}

function outcomeForResult(result: StopDebuggerResult): StopAllOutcome {
  return {
    sessionId: result.sessionId,
    app: result.app,
    status: result.pending ? "pending" : result.stale ? "stale" : "stopped",
    result,
  };
}

function outcomeForError(session: ActiveSession, error: unknown): StopAllOutcome {
  const normalized = error instanceof CfDebuggerError
    ? error
    : new CfDebuggerError(
      "STOP_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  return {
    sessionId: session.sessionId,
    app: session.app,
    status: "failed",
    error: normalized,
  };
}

function outcomeForMissing(session: ActiveSession): StopAllOutcome {
  return {
    sessionId: session.sessionId,
    app: session.app,
    status: "stale",
  };
}

function summarizeOutcomes(outcomes: readonly StopAllOutcome[]): StopAllResult {
  const count = (status: StopAllOutcome["status"]): number =>
    outcomes.filter((outcome) => outcome.status === status).length;
  return {
    outcomes,
    failed: count("failed"),
    pending: count("pending"),
    stale: count("stale"),
    stopped: count("stopped"),
  };
}

export async function stopAllDebuggers(force = false): Promise<StopAllResult> {
  const sessions = (await readSessionSnapshot()).filter(
    (session) => session.hostname === getHostname(),
  );
  const outcomes: StopAllOutcome[] = [];
  for (const session of sessions) {
    try {
      const result = await stopDebugger({ sessionId: session.sessionId, force });
      outcomes.push(
        result === undefined ? outcomeForMissing(session) : outcomeForResult(result),
      );
    } catch (error: unknown) {
      outcomes.push(outcomeForError(session, error));
    }
  }
  return summarizeOutcomes(outcomes);
}

export async function listSessions(): Promise<readonly ActiveSession[]> {
  return await readActiveSessions();
}

export async function getSession(key: SessionKey): Promise<ActiveSession | undefined> {
  const sessions = await readActiveSessions();
  return findMatchingSession(sessions, { key });
}
