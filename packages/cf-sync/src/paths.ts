import { homedir } from "node:os";
import { join } from "node:path";

export const SAPTOOLS_DIR_NAME = ".saptools";
export const CF_STRUCTURE_FILENAME = "cf-structure.json";
export const CF_RUNTIME_STATE_FILENAME = "cf-sync-state.json";
export const CF_SYNC_LOCK_FILENAME = "cf-sync.lock";
export const CF_STATE_LOCK_FILENAME = "cf-sync-state.lock";
export const CF_SYNC_HISTORY_FILENAME = "cf-sync-history.jsonl";
export const CF_DB_SNAPSHOT_FILENAME = "cf-db-bindings.json";
export const CF_DB_RUNTIME_STATE_FILENAME = "cf-db-sync-state.json";
export const CF_DB_SYNC_LOCK_FILENAME = "cf-db-sync.lock";
export const CF_DB_STATE_LOCK_FILENAME = "cf-db-sync-state.lock";
export const CF_DB_SYNC_HISTORY_FILENAME = "cf-db-sync-history.jsonl";

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

export function cfDbSnapshotPath(): string {
  return join(saptoolsDir(), CF_DB_SNAPSHOT_FILENAME);
}

export function cfDbRuntimeStatePath(): string {
  return join(saptoolsDir(), CF_DB_RUNTIME_STATE_FILENAME);
}

export function cfDbSyncLockPath(): string {
  return join(saptoolsDir(), CF_DB_SYNC_LOCK_FILENAME);
}

export function cfDbStateLockPath(): string {
  return join(saptoolsDir(), CF_DB_STATE_LOCK_FILENAME);
}

export function cfDbSyncHistoryPath(): string {
  return join(saptoolsDir(), CF_DB_SYNC_HISTORY_FILENAME);
}
