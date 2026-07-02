import { rm } from "node:fs/promises";
import process from "node:process";

import { killProcessOnPort } from "../port.js";
import { matchesKey, readActiveSessions, removeSession } from "../state.js";
import type { ActiveSession, SessionKey } from "../types.js";

import { PORT_CLEANUP_DELAY_MS } from "./constants.js";
import { pruneAndCleanupOrphans } from "./orphans.js";
import { terminatePidOrGroup } from "./processes.js";

export interface StopOptions {
  readonly sessionId?: string;
  readonly key?: SessionKey;
}

export interface StopDebuggerResult extends ActiveSession {
  readonly stale: boolean;
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
    return sessions.find((s) => matchesKey(s, key));
  }
  return undefined;
}

async function cleanupSession(target: ActiveSession, stale: boolean): Promise<StopDebuggerResult> {
  if (!stale && target.pid !== process.pid) {
    try {
      await terminatePidOrGroup(target.pid);
    } catch {
      // process already gone — cleanup below
    }
  }
  setTimeout(() => {
    void killProcessOnPort(target.localPort);
  }, PORT_CLEANUP_DELAY_MS);
  const removed = stale ? undefined : await removeSession(target.sessionId);
  try {
    await rm(target.cfHomeDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  return { ...(removed ?? target), stale };
}

export async function stopDebugger(options: StopOptions): Promise<StopDebuggerResult | undefined> {
  const pruneResult = await pruneAndCleanupOrphans();
  const activeTarget = findMatchingSession(pruneResult.sessions, options);
  if (activeTarget !== undefined) {
    return await cleanupSession(activeTarget, false);
  }

  const staleTarget = findMatchingSession(pruneResult.removed, options);
  if (staleTarget !== undefined) {
    return await cleanupSession(staleTarget, true);
  }

  return undefined;
}

export async function stopAllDebuggers(): Promise<number> {
  const pruneResult = await pruneAndCleanupOrphans();
  let stopped = pruneResult.removed.length;
  for (const session of pruneResult.sessions) {
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
  return sessions.find((s) => matchesKey(s, key));
}
