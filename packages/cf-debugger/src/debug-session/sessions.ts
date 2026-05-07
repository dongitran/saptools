import { rm } from "node:fs/promises";
import process from "node:process";

import { killProcessOnPort } from "../port.js";
import { matchesKey, readSessionSnapshot, removeSession } from "../state.js";
import type { ActiveSession, SessionKey } from "../types.js";

import { PORT_CLEANUP_DELAY_MS } from "./constants.js";
import { pruneAndCleanupOrphans } from "./orphans.js";
import { terminatePidOrGroup } from "./processes.js";

export interface StopOptions {
  readonly sessionId?: string;
  readonly key?: SessionKey;
}

export async function stopDebugger(options: StopOptions): Promise<ActiveSession | undefined> {
  const sessions = await pruneAndCleanupOrphans();
  let target: ActiveSession | undefined;
  if (options.sessionId !== undefined) {
    target = sessions.find((s) => s.sessionId === options.sessionId);
  } else if (options.key !== undefined) {
    const key = options.key;
    target = sessions.find((s) => matchesKey(s, key));
  }
  if (target === undefined) {
    return undefined;
  }
  if (target.pid !== process.pid) {
    try {
      await terminatePidOrGroup(target.pid);
    } catch {
      // process already gone — cleanup below
    }
  }
  setTimeout(() => {
    void killProcessOnPort(target.localPort);
  }, PORT_CLEANUP_DELAY_MS);
  const removed = await removeSession(target.sessionId);
  try {
    await rm(target.cfHomeDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  return removed ?? target;
}

export async function stopAllDebuggers(): Promise<number> {
  const sessions = await pruneAndCleanupOrphans();
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
  return await readSessionSnapshot();
}

export async function getSession(key: SessionKey): Promise<ActiveSession | undefined> {
  const sessions = await readSessionSnapshot();
  return sessions.find((s) => matchesKey(s, key));
}
