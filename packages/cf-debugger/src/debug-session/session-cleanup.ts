import { isOwnedSessionCfHomeDir } from "../paths.js";
import { removeSession } from "../state.js";
import type { ActiveSession } from "../types.js";

import { tryRemoveOwnedSessionCfHome } from "./session-home.js";

export type SessionHomeCleanupStatus = "removed" | "retained" | "unowned";

export interface ForgottenSessionCleanup {
  readonly homeStatus: SessionHomeCleanupStatus;
  readonly removed: ActiveSession | undefined;
}

export async function forgetSessionThenCleanupHome(
  session: Pick<ActiveSession, "cfHomeDir" | "sessionId">,
): Promise<ForgottenSessionCleanup> {
  const removed = await removeSession(session.sessionId);
  if (!isOwnedSessionCfHomeDir(session.sessionId, session.cfHomeDir)) {
    return { homeStatus: "unowned", removed };
  }
  const homeRemoved = await tryRemoveOwnedSessionCfHome(
    session.sessionId,
    session.cfHomeDir,
  );
  return {
    homeStatus: homeRemoved ? "removed" : "retained",
    removed,
  };
}
