import { hostname } from "node:os";
import nodeProcess from "node:process";

import {
  inspectSessionHealth,
  type SessionHealthVerdict,
} from "../session-state/store.js";
import type { ActiveSession } from "../types.js";

export interface DoctorSessionHealthFinding {
  readonly session: ActiveSession;
  readonly health: SessionHealthVerdict;
}

function missingIdentityCaveat(session: ActiveSession): string | undefined {
  const identity = session.status === "ready"
    ? session.tunnelProcessIdentity
    : session.controllerProcessIdentity;
  return (
    (nodeProcess.platform === "linux" || nodeProcess.platform === "darwin") &&
    identity === undefined
  )
    ? "process identity token is absent, so PID-only compatibility is in use; " +
      "an older cf-debugger sharing this state file may have stripped the additive field"
    : undefined;
}

export async function inspectDoctorSessions(
  sessions: readonly ActiveSession[],
): Promise<readonly DoctorSessionHealthFinding[]> {
  const local = sessions.filter((session) => session.hostname === hostname());
  return await Promise.all(local.map(async (session): Promise<DoctorSessionHealthFinding> => {
    try {
      const health = await inspectSessionHealth(session);
      const caveat = missingIdentityCaveat(session);
      return {
        session,
        health: caveat === undefined
          ? health
          : { ...health, reason: `${health.reason}; ${caveat}` },
      };
    } catch (error: unknown) {
      return {
        session,
        health: {
          status: "unverified",
          reason: `health inspection failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      };
    }
  }));
}
