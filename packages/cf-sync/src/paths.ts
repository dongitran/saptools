import { homedir } from "node:os";
import { join } from "node:path";

export const SAPTOOLS_DIR_NAME = ".saptools";
export const CF_STRUCTURE_FILENAME = "cf-structure.json";
export const CF_RUNTIME_STATE_FILENAME = "cf-sync-state.json";
export const CF_SYNC_LOCK_FILENAME = "cf-sync.lock";
export const CF_STATE_LOCK_FILENAME = "cf-sync-state.lock";
export const CF_SYNC_HISTORY_FILENAME = "cf-sync-history.jsonl";

export function saptoolsDir(): string {
  return join(homedir(), SAPTOOLS_DIR_NAME);
}

export function cfStructurePath(): string {
  return join(saptoolsDir(), CF_STRUCTURE_FILENAME);
}

export function cfRuntimeStatePath(): string {
  return join(saptoolsDir(), CF_RUNTIME_STATE_FILENAME);
}

export function cfSyncLockPath(): string {
  return join(saptoolsDir(), CF_SYNC_LOCK_FILENAME);
}

export function cfStateLockPath(): string {
  return join(saptoolsDir(), CF_STATE_LOCK_FILENAME);
}

export function cfSyncHistoryPath(): string {
  return join(saptoolsDir(), CF_SYNC_HISTORY_FILENAME);
}
