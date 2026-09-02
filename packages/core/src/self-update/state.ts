import { closeSync, openSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import { isRecord, readString } from "../records.js";
import { ensurePrivateDirectorySync, readJsonFileSync, writeFileAtomicSync } from "../saptools-paths.js";

export interface InstallAttempt {
  readonly version: string;
  readonly at: string;
  readonly ok: boolean;
  readonly reason?: string;
}

export interface UpdateState {
  readonly version: 1;
  readonly checkedAt?: string;
  readonly latest?: string;
  readonly lastFailureAt?: string;
  readonly lastFailureReason?: string;
  readonly notifiedVersion?: string;
  readonly notifiedAt?: string;
  readonly lastInstall?: InstallAttempt;
}

type UpdateStateDraft = { -readonly [K in keyof UpdateState]: UpdateState[K] };

export const EMPTY_UPDATE_STATE: UpdateState = { version: 1 };
export const UPDATES_DIRECTORY_NAME = "updates";
/** A stuck installer holds the lock this long before another instance may take over. */
export const DEFAULT_LOCK_STALE_MS = 10 * 60_000;

const STRING_FIELDS = ["checkedAt", "latest", "lastFailureAt", "lastFailureReason", "notifiedVersion", "notifiedAt"] as const;

/** `@saptools/cf-metrics` → `saptools__cf-metrics.json`: one file per package, no shared writes between CLIs. */
export function updateStateFileName(packageName: string): string {
  return `${packageName.replace(/^@/, "").replaceAll("/", "__")}.json`;
}

export function updateStatePath(saptoolsRoot: string, packageName: string): string {
  return join(saptoolsRoot, UPDATES_DIRECTORY_NAME, updateStateFileName(packageName));
}

export function updateLockPath(statePath: string): string {
  return statePath.replace(/\.json$/, ".lock");
}

function readInstallAttempt(value: unknown): InstallAttempt | undefined {
  if (!isRecord(value)) {
    return;
  }
  const version = readString(value, "version");
  const at = readString(value, "at");
  const ok = value["ok"];
  if (version === undefined || at === undefined || typeof ok !== "boolean") {
    return;
  }
  const reason = readString(value, "reason");
  return reason === undefined ? { version, at, ok } : { version, at, ok, reason };
}

/** Tolerant read: an unknown, malformed, or older-format file reads as empty state. */
export function readUpdateState(path: string): UpdateState {
  const parsed = readJsonFileSync(path);
  if (!isRecord(parsed) || parsed["version"] !== 1) {
    return EMPTY_UPDATE_STATE;
  }
  const draft: UpdateStateDraft = { version: 1 };
  for (const key of STRING_FIELDS) {
    const value = readString(parsed, key);
    if (value !== undefined) {
      draft[key] = value;
    }
  }
  const lastInstall = readInstallAttempt(parsed["lastInstall"]);
  if (lastInstall !== undefined) {
    draft.lastInstall = lastInstall;
  }
  return draft;
}

/** The same state with a successful check: the failure fields no longer apply. */
export function clearFailure(state: UpdateState): UpdateState {
  const next: UpdateStateDraft = { ...state };
  delete next.lastFailureAt;
  delete next.lastFailureReason;
  return next;
}

export function writeUpdateState(path: string, state: UpdateState): void {
  ensurePrivateDirectorySync(dirname(path));
  writeFileAtomicSync(path, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

export interface UpdateLock {
  readonly release: () => void;
}

function tryCreateLock(lockPath: string, now: Date): UpdateLock | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch {
    return;
  }
  try {
    writeSync(descriptor, `${JSON.stringify({ pid: process.pid, at: now.toISOString() })}\n`);
  } finally {
    closeSync(descriptor);
  }
  // Staleness is judged against the caller's clock, so stamp the file with it rather than the filesystem's.
  utimesSync(lockPath, now, now);
  return {
    release: (): void => {
      rmSync(lockPath, { force: true });
    },
  };
}

function isStaleLock(lockPath: string, now: Date, staleMs: number): boolean {
  try {
    return now.getTime() - statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/**
 * Exclusive-create lock so two commands started at once install only once;
 * the loser skips the update and runs on the installed version. A lock older
 * than `staleMs` belongs to a crashed installer and is taken over.
 */
export function acquireUpdateLock(lockPath: string, now: Date, staleMs = DEFAULT_LOCK_STALE_MS): UpdateLock | undefined {
  ensurePrivateDirectorySync(dirname(lockPath));
  const lock = tryCreateLock(lockPath, now);
  if (lock !== undefined) {
    return lock;
  }
  if (!isStaleLock(lockPath, now, staleMs)) {
    return;
  }
  rmSync(lockPath, { force: true });
  return tryCreateLock(lockPath, now);
}
