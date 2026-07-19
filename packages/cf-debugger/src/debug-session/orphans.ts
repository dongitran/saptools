import { rm } from "node:fs/promises";
import { hostname as getHostname } from "node:os";

import { isOwnedSessionCfHomeDir } from "../paths.js";
import { readAndPruneActiveSessions } from "../state.js";
import type { ActiveSession } from "../types.js";

export interface PruneCleanupResult {
  readonly sessions: readonly ActiveSession[];
  readonly removed: readonly ActiveSession[];
}

export async function pruneAndCleanupOrphans(): Promise<PruneCleanupResult> {
  const result = await readAndPruneActiveSessions();
  const host = getHostname();
  for (const removed of result.removed) {
    if (removed.hostname === host && isOwnedSessionCfHomeDir(removed.sessionId, removed.cfHomeDir)) {
      try {
        await rm(removed.cfHomeDir, { recursive: true, force: true });
      } catch {
        // A stale credential cache must not prevent cleanup of the state record.
      }
    }
  }
  return result;
}
