import type { ActiveSession } from "../types.js";
import { CfDebuggerError } from "../types.js";

import {
  MAX_STARTUP_TIMEOUT_MS,
  STARTUP_STALE_SLACK_MS,
} from "./constants.js";
import { inspectProcessIdentity } from "./process-identity.js";
import type { ProcessIdentityVerdict } from "./process-identity.js";

export type RecordedProcessVerdict = "dead" | ProcessIdentityVerdict;
export type PidLivenessProbe = (pid: number) => boolean;

export function startupAgeLimit(session: ActiveSession): number {
  return (session.startupTimeoutMs ?? MAX_STARTUP_TIMEOUT_MS) + STARTUP_STALE_SLACK_MS;
}

export function startupExpired(session: ActiveSession): boolean {
  const startedAt = Date.parse(session.startedAt);
  return Number.isNaN(startedAt) || Date.now() - startedAt > startupAgeLimit(session);
}

export async function inspectRecordedProcess(
  pid: number,
  identity: string | undefined,
  isAlive: PidLivenessProbe,
  signal?: AbortSignal,
): Promise<RecordedProcessVerdict> {
  if (signal?.aborted) {
    throw new CfDebuggerError("ABORTED", "Session health inspection was aborted.");
  }
  if (!isAlive(pid)) {
    return "dead";
  }
  return await inspectProcessIdentity(pid, identity, signal);
}
