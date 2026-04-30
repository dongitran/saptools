import { homedir } from "node:os";
import { join } from "node:path";

const SAPTOOLS_DIR_NAME = ".saptools";
const CF_EXPLORER_DIR_NAME = "cf-explorer";
const SESSIONS_FILENAME = "sessions.json";
const SESSIONS_LOCK_FILENAME = "sessions.lock";

export function explorerHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["CF_EXPLORER_HOME"];
  return override === undefined || override.trim().length === 0
    ? join(homedir(), SAPTOOLS_DIR_NAME, CF_EXPLORER_DIR_NAME)
    : override;
}

export function sessionsFilePath(homeDir: string = explorerHome()): string {
  return join(homeDir, SESSIONS_FILENAME);
}

export function sessionsLockPath(homeDir: string = explorerHome()): string {
  return join(homeDir, SESSIONS_LOCK_FILENAME);
}

export function socketsDir(homeDir: string = explorerHome()): string {
  return join(homeDir, "sockets");
}

function fallbackSocketsDir(): string {
  const uidSuffix = typeof process.getuid === "function" ? `-${process.getuid().toString()}` : "";
  return join("/tmp", `saptools-cf-explorer${uidSuffix}`);
}

export function sessionSocketPath(sessionId: string, homeDir: string = explorerHome()): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\saptools-cf-explorer-${sessionId}`;
  }
  const socketPath = join(socketsDir(homeDir), `${sessionId}.sock`);
  return socketPath.length < 100
    ? socketPath
    : join(fallbackSocketsDir(), `${sessionId}.sock`);
}

export function cfHomesDir(homeDir: string = explorerHome()): string {
  return join(homeDir, "cf-homes");
}

export function sessionCfHomeDir(sessionId: string, homeDir: string = explorerHome()): string {
  return join(cfHomesDir(homeDir), sessionId);
}

export function tmpRunsDir(homeDir: string = explorerHome()): string {
  return join(homeDir, "tmp");
}

export function tmpRunDir(runId: string, homeDir: string = explorerHome()): string {
  return join(tmpRunsDir(homeDir), runId);
}
