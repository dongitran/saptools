import { homedir } from "node:os";
import { join } from "node:path";

const SAPTOOLS_DIR_NAME = ".saptools";
const CF_LOGS_STORE_FILENAME = "cf-logs-store.json";
const CF_LOGS_STORE_LOCK_FILENAME = "cf-logs-store.lock";
const CF_LOGS_SESSIONS_DIRNAME = "cf-logs-sessions";

export function saptoolsDir(): string {
  return join(homedir(), SAPTOOLS_DIR_NAME);
}

export function cfLogsStorePath(): string {
  return join(saptoolsDir(), CF_LOGS_STORE_FILENAME);
}

export function cfLogsStoreLockPath(): string {
  return join(saptoolsDir(), CF_LOGS_STORE_LOCK_FILENAME);
}

export function cfLogsSessionsDir(): string {
  return join(saptoolsDir(), CF_LOGS_SESSIONS_DIRNAME);
}
