import { hostname as getHostname } from "node:os";

import { killProcessOnPort } from "../port.js";
import { readAndPruneActiveSessions } from "../state.js";
import type { ActiveSession } from "../types.js";

export async function pruneAndCleanupOrphans(): Promise<readonly ActiveSession[]> {
  const result = await readAndPruneActiveSessions();
  const host = getHostname();
  for (const removed of result.removed) {
    if (removed.hostname === host) {
      void killProcessOnPort(removed.localPort);
    }
  }
  return result.sessions;
}
