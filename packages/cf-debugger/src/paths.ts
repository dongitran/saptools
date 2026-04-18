import { homedir } from "node:os";
import { join } from "node:path";

export const SAPTOOLS_DIR_NAME = ".saptools";
export const CF_DEBUGGER_STATE_FILENAME = "cf-debugger-state.json";
export const CF_DEBUGGER_LOCK_FILENAME = "cf-debugger-state.lock";
export const CF_DEBUGGER_HOMES_DIRNAME = "cf-debugger-homes";

export function saptoolsDir(): string {
  return join(homedir(), SAPTOOLS_DIR_NAME);
}

export function stateFilePath(): string {
  return join(saptoolsDir(), CF_DEBUGGER_STATE_FILENAME);
}

export function stateLockPath(): string {
  return join(saptoolsDir(), CF_DEBUGGER_LOCK_FILENAME);
}

export function sessionCfHomeDir(sessionId: string): string {
  return join(saptoolsDir(), CF_DEBUGGER_HOMES_DIRNAME, sessionId);
}
