import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname as getHostname } from "node:os";
import { dirname } from "node:path";
import process from "node:process";

import { CfExplorerError } from "./errors.js";
import { withFileLock } from "./lock.js";
import {
  sessionCfHomeDir,
  sessionSocketPath,
  sessionsFilePath,
  sessionsLockPath,
} from "./paths.js";
import {
  SESSION_STATUSES,
  type ExplorerSessionRecord,
  type ExplorerTarget,
  type SessionStatus,
  type SessionTarget,
} from "./types.js";

const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

interface SessionStateFile {
  readonly version: 1;
  readonly sessions: readonly ExplorerSessionRecord[];
}

export interface RegisterSessionInput {
  readonly sessionId?: string;
  readonly brokerPid: number;
  readonly target: ExplorerTarget;
  readonly process: string;
  readonly instance: number;
  readonly homeDir: string;
  readonly status?: SessionStatus;
}

export function isPidAlive(pid: number | undefined): boolean {
  if (pid === undefined || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function listExplorerSessions(
  homeDir: string,
): Promise<readonly ExplorerSessionRecord[]> {
  return await withFileLock(sessionsLockPath(homeDir), async () => {
    const result = await readAndPruneStateUnlocked(homeDir);
    return result.sessions;
  });
}

export async function readExplorerSession(
  homeDir: string,
  sessionId: string,
): Promise<ExplorerSessionRecord | undefined> {
  const sessions = await listExplorerSessions(homeDir);
  return sessions.find((session) => session.sessionId === sessionId);
}

export async function registerExplorerSession(
  input: RegisterSessionInput,
): Promise<ExplorerSessionRecord> {
  return await withFileLock(sessionsLockPath(input.homeDir), async () => {
    const current = await readAndPruneStateUnlocked(input.homeDir);
    const sessionId = input.sessionId ?? randomUUID();
    assertSafeSessionId(sessionId);
    const now = new Date().toISOString();
    const session = createSessionRecord(input, sessionId, now);
    await writeStateUnlocked(input.homeDir, {
      version: 1,
      sessions: [...current.sessions, session],
    });
    return session;
  });
}

export async function updateExplorerSession(
  homeDir: string,
  sessionId: string,
  patch: Partial<Pick<ExplorerSessionRecord, "brokerPid" | "lastUsedAt" | "message" | "sshPid" | "status">>,
): Promise<ExplorerSessionRecord | undefined> {
  return await withFileLock(sessionsLockPath(homeDir), async () => {
    const state = await readStateUnlocked(homeDir);
    let updated: ExplorerSessionRecord | undefined;
    const sessions = state.sessions.map((session) => {
      if (session.sessionId !== sessionId) {
        return session;
      }
      updated = mergeSessionPatch(session, patch);
      return updated;
    });
    await writeStateUnlocked(homeDir, { version: 1, sessions });
    return updated;
  });
}

export async function removeExplorerSession(
  homeDir: string,
  sessionId: string,
): Promise<ExplorerSessionRecord | undefined> {
  return await withFileLock(sessionsLockPath(homeDir), async () => {
    const state = await readStateUnlocked(homeDir);
    const removed = state.sessions.find((session) => session.sessionId === sessionId);
    const sessions = state.sessions.filter((session) => session.sessionId !== sessionId);
    await writeStateUnlocked(homeDir, { version: 1, sessions });
    return removed;
  });
}

export async function markSessionsStaleForTarget(
  homeDir: string,
  target: ExplorerTarget,
  message: string,
): Promise<readonly ExplorerSessionRecord[]> {
  return await withFileLock(sessionsLockPath(homeDir), async () => {
    const state = await readStateUnlocked(homeDir);
    const now = new Date().toISOString();
    const stale: ExplorerSessionRecord[] = [];
    const sessions = state.sessions.map((session) => {
      if (!matchesSessionTarget(session, target)) {
        return session;
      }
      const updated = { ...session, status: "stale" as const, lastUsedAt: now, message };
      stale.push(updated);
      return updated;
    });
    await writeStateUnlocked(homeDir, { version: 1, sessions });
    return stale;
  });
}

export function matchesSessionTarget(
  session: Pick<ExplorerSessionRecord, "target">,
  target: ExplorerTarget,
): boolean {
  return (
    session.target.region === target.region &&
    session.target.org === target.org &&
    session.target.space === target.space &&
    session.target.app === target.app
  );
}

export function toSessionTarget(session: ExplorerSessionRecord): SessionTarget {
  return {
    ...session.target,
    process: session.process,
    instance: session.instance,
  };
}

async function readAndPruneStateUnlocked(homeDir: string): Promise<SessionStateFile> {
  const state = await readStateUnlocked(homeDir);
  const sessions = state.sessions.filter(isSessionUsable);
  if (sessions.length !== state.sessions.length) {
    await writeStateUnlocked(homeDir, { version: 1, sessions });
  }
  return { version: 1, sessions };
}

async function readStateUnlocked(homeDir: string): Promise<SessionStateFile> {
  let raw: string;
  try {
    raw = await readFile(sessionsFilePath(homeDir), "utf8");
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return emptyState();
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parseStateFile(parsed, homeDir) ?? emptyState();
  } catch {
    return emptyState();
  }
}

async function writeStateUnlocked(homeDir: string, state: SessionStateFile): Promise<void> {
  const path = sessionsFilePath(homeDir);
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, path);
}

function emptyState(): SessionStateFile {
  return { version: 1, sessions: [] };
}

function parseStateFile(value: unknown, homeDir: string): SessionStateFile | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Partial<SessionStateFile>;
  if (candidate.version !== 1 || !Array.isArray(candidate.sessions)) {
    return undefined;
  }
  return {
    version: 1,
    sessions: candidate.sessions.filter((session) => isSessionRecord(session, homeDir)),
  };
}

function isSessionRecord(value: unknown, homeDir: string): value is ExplorerSessionRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ExplorerSessionRecord>;
  const target = (value as { readonly target?: unknown }).target;
  return (
    isNonEmptyString(candidate.sessionId) &&
    isSafeSessionId(candidate.sessionId) &&
    isPositiveInteger(candidate.brokerPid) &&
    isOptionalPositiveInteger(candidate.sshPid) &&
    isNonEmptyString(candidate.hostname) &&
    isNonEmptyString(candidate.socketPath) &&
    isExplorerTarget(target) &&
    isNonEmptyString(candidate.process) &&
    typeof candidate.instance === "number" &&
    Number.isInteger(candidate.instance) &&
    candidate.instance >= 0 &&
    isNonEmptyString(candidate.cfHomeDir) &&
    candidate.socketPath === sessionSocketPath(candidate.sessionId, homeDir) &&
    candidate.cfHomeDir === sessionCfHomeDir(candidate.sessionId, homeDir) &&
    isNonEmptyString(candidate.startedAt) &&
    isNonEmptyString(candidate.lastUsedAt) &&
    isSessionStatus(candidate.status) &&
    isOptionalString(candidate.message)
  );
}

function isExplorerTarget(value: unknown): value is ExplorerTarget {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ExplorerTarget>;
  return (
    isNonEmptyString(candidate.region) &&
    isNonEmptyString(candidate.org) &&
    isNonEmptyString(candidate.space) &&
    isNonEmptyString(candidate.app) &&
    isOptionalString(candidate.apiEndpoint)
  );
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && (SESSION_STATUSES as readonly string[]).includes(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function isOptionalPositiveInteger(value: unknown): value is number | undefined {
  return value === undefined || isPositiveInteger(value);
}

function assertSafeSessionId(sessionId: string): void {
  if (!isSafeSessionId(sessionId)) {
    throw new CfExplorerError("UNSAFE_INPUT", "Session id must be a simple identifier.");
  }
}

function isSafeSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

function isSessionUsable(session: ExplorerSessionRecord): boolean {
  if (session.status === "stopped") {
    return false;
  }
  if (session.hostname !== getHostname()) {
    return false;
  }
  if (session.status === "error" || session.status === "stale") {
    return true;
  }
  return isPidAlive(session.brokerPid);
}

function createSessionRecord(
  input: RegisterSessionInput,
  sessionId: string,
  now: string,
): ExplorerSessionRecord {
  return {
    sessionId,
    brokerPid: input.brokerPid,
    hostname: getHostname(),
    socketPath: sessionSocketPath(sessionId, input.homeDir),
    target: input.target,
    process: input.process,
    instance: input.instance,
    cfHomeDir: sessionCfHomeDir(sessionId, input.homeDir),
    startedAt: now,
    lastUsedAt: now,
    status: input.status ?? "starting",
  };
}

function mergeSessionPatch(
  session: ExplorerSessionRecord,
  patch: Partial<Pick<ExplorerSessionRecord, "brokerPid" | "lastUsedAt" | "message" | "sshPid" | "status">>,
): ExplorerSessionRecord {
  return {
    ...session,
    ...(patch.brokerPid === undefined ? {} : { brokerPid: patch.brokerPid }),
    ...(patch.sshPid === undefined ? {} : { sshPid: patch.sshPid }),
    ...(patch.status === undefined ? {} : { status: patch.status }),
    ...(patch.message === undefined ? {} : { message: patch.message }),
    lastUsedAt: patch.lastUsedAt ?? session.lastUsedAt,
  };
}

export async function cleanupSessionFiles(session: ExplorerSessionRecord, homeDir: string): Promise<void> {
  assertSafeSessionId(session.sessionId);
  if (
    session.socketPath !== sessionSocketPath(session.sessionId, homeDir) ||
    session.cfHomeDir !== sessionCfHomeDir(session.sessionId, homeDir)
  ) {
    throw new CfExplorerError("UNSAFE_INPUT", "Refusing to clean up paths outside the explorer session home.");
  }
  await rm(session.socketPath, { force: true }).catch(() => Promise.resolve());
  await rm(session.cfHomeDir, { recursive: true, force: true }).catch(() => Promise.resolve());
}
