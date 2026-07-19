import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const SAPTOOLS_DIR_NAME = ".saptools";
export const CF_DEBUGGER_STATE_FILENAME = "cf-debugger-state-v2.json";
export const CF_DEBUGGER_LOCK_FILENAME = "cf-debugger-state-v2.lock";
export const CF_DEBUGGER_HOMES_DIRNAME = "cf-debugger-homes-v2";
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function saptoolsDir(): string {
  return join(homedir(), SAPTOOLS_DIR_NAME);
}

export function stateFilePath(): string {
  return join(saptoolsDir(), CF_DEBUGGER_STATE_FILENAME);
}

export function stateLockPath(): string {
  return join(saptoolsDir(), CF_DEBUGGER_LOCK_FILENAME);
}

export function isSafeSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

export function sessionCfHomeDir(sessionId: string): string {
  if (!isSafeSessionId(sessionId)) {
    throw new Error("Invalid debugger session ID.");
  }
  return join(saptoolsDir(), CF_DEBUGGER_HOMES_DIRNAME, sessionId);
}

export function isOwnedSessionCfHomeDir(sessionId: string, candidate: string): boolean {
  if (!isSafeSessionId(sessionId) || !isAbsolute(candidate)) {
    return false;
  }
  return candidate === sessionCfHomeDir(sessionId);
}
