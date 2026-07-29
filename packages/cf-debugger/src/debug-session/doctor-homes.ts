import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  CF_DEBUGGER_HOMES_DIRNAME,
  isOwnedSessionCfHomeDir,
  saptoolsDir,
} from "../paths.js";
import type { ActiveSession } from "../types.js";

import { inspectSessionHomesRoot } from "./session-home.js";

export interface DoctorHomeCandidate {
  readonly sessionId: string;
  readonly path: string;
  readonly cleanupEligible: boolean;
  readonly reason?: string;
}

export interface DoctorHomeDiscovery {
  readonly candidates: readonly DoctorHomeCandidate[];
  readonly warnings: readonly string[];
}

function entryReason(
  symbolicLink: boolean,
  directory: boolean,
  cleanupEligible: boolean,
): string | undefined {
  if (symbolicLink) {
    return "entry is a symbolic link, not a debugger CF home directory";
  }
  if (!directory) {
    return "entry is not a directory";
  }
  return cleanupEligible ? undefined : "entry name is not a safe debugger session ID";
}

export async function discoverOrphanHomes(
  sessions: readonly ActiveSession[],
): Promise<DoctorHomeDiscovery> {
  const root = join(saptoolsDir(), CF_DEBUGGER_HOMES_DIRNAME);
  const rootInspection = await inspectSessionHomesRoot(root);
  if (rootInspection.status === "unsafe") {
    return { candidates: [], warnings: [rootInspection.reason] };
  }
  if (rootInspection.status === "absent") {
    return { candidates: [], warnings: [] };
  }
  const claimed = new Set(sessions.map((session) => session.sessionId));
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => !entry.isDirectory() || !claimed.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry): DoctorHomeCandidate => {
      const path = join(root, entry.name);
      const cleanupEligible = entry.isDirectory() &&
        isOwnedSessionCfHomeDir(entry.name, path);
      const reason = entryReason(
        entry.isSymbolicLink(),
        entry.isDirectory(),
        cleanupEligible,
      );
      return {
        sessionId: entry.name,
        path,
        cleanupEligible,
        ...(reason === undefined ? {} : { reason }),
      };
    });
  return { candidates, warnings: [] };
}
