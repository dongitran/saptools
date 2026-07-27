import { readdir, stat, unlink } from "node:fs/promises";
import { hostname as getHostname } from "node:os";
import { join } from "node:path";

import {
  CF_DEBUGGER_STATE_FILENAME,
  saptoolsDir,
} from "../paths.js";
import { readAndPruneActiveSessions } from "../state.js";
import type { StateAccessOptions } from "../state.js";
import type { ActiveSession } from "../types.js";

import { tryRemoveOwnedSessionCfHome } from "./session-home.js";

const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1_000;

export interface PruneCleanupResult {
  readonly sessions: readonly ActiveSession[];
  readonly removed: readonly ActiveSession[];
}

async function modifiedAt(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function cleanupStaleStateTemps(): Promise<void> {
  const root = saptoolsDir();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.startsWith(`${CF_DEBUGGER_STATE_FILENAME}.`) ||
      !entry.name.endsWith(".tmp")
    ) {
      continue;
    }
    const path = join(root, entry.name);
    const mtimeMs = await modifiedAt(path);
    if (mtimeMs !== undefined && now - mtimeMs >= STALE_TEMP_AGE_MS) {
      await unlink(path).catch(() => false);
    }
  }
}

export async function pruneAndCleanupOrphans(
  stateAccess?: StateAccessOptions,
): Promise<PruneCleanupResult> {
  const result = await readAndPruneActiveSessions(stateAccess);
  const host = getHostname();
  for (const removed of result.removed) {
    if (removed.hostname === host) {
      await tryRemoveOwnedSessionCfHome(removed.sessionId, removed.cfHomeDir);
    }
  }
  await cleanupStaleStateTemps();
  return result;
}
