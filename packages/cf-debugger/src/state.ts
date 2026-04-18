import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname as getHostname } from "node:os";
import { dirname } from "node:path";
import process from "node:process";

import { withFileLock } from "./lock.js";
import { stateFilePath, stateLockPath } from "./paths.js";
import { CfDebuggerError } from "./types.js";
import type { ActiveSession, SessionKey, StateFile } from "./types.js";

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    process.stderr.write(
      `[cf-debugger] warning: state file at ${path} is not valid JSON; resetting to empty.\n`,
    );
    return undefined;
  }
}

async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

function emptyState(): StateFile {
  return { version: "1", sessions: [] };
}

function isValidState(value: unknown): value is StateFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<StateFile>;
  return candidate.version === "1" && Array.isArray(candidate.sessions);
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function filterStaleSessions(sessions: readonly ActiveSession[]): readonly ActiveSession[] {
  const host = getHostname();
  return sessions.filter((session) => {
    if (session.hostname !== host) {
      return true;
    }
    return isPidAlive(session.pid);
  });
}

async function readStateRaw(): Promise<StateFile> {
  const parsed = await readJsonFile<unknown>(stateFilePath());
  if (!isValidState(parsed)) {
    return emptyState();
  }
  return parsed;
}

async function writeState(state: StateFile): Promise<void> {
  await writeJsonFileAtomic(stateFilePath(), state);
}

export interface StateReaderResult {
  readonly sessions: readonly ActiveSession[];
  readonly removed: readonly ActiveSession[];
}

async function readAndPruneLocked(): Promise<StateReaderResult> {
  const raw = await readStateRaw();
  const pruned = filterStaleSessions(raw.sessions);
  const removed = raw.sessions.filter(
    (session) => !pruned.some((active) => active.sessionId === session.sessionId),
  );

  if (removed.length > 0) {
    await writeState({ version: "1", sessions: pruned });
  }

  return { sessions: pruned, removed };
}

export async function readActiveSessions(): Promise<readonly ActiveSession[]> {
  const result = await withFileLock(stateLockPath(), readAndPruneLocked);
  return result.sessions;
}

export async function readAndPruneActiveSessions(): Promise<StateReaderResult> {
  return await withFileLock(stateLockPath(), readAndPruneLocked);
}

export function sessionKeyString(key: SessionKey): string {
  return `${key.region}:${key.org}:${key.space}:${key.app}`;
}

export function matchesKey(session: SessionKey, key: SessionKey): boolean {
  return (
    session.region === key.region &&
    session.org === key.org &&
    session.space === key.space &&
    session.app === key.app
  );
}

export interface RegisterSessionResult {
  readonly session: ActiveSession;
  readonly existing?: ActiveSession;
}

export interface RegisterSessionInput extends SessionKey {
  readonly apiEndpoint: string;
  readonly preferredPort?: number;
  readonly portProbe: (port: number) => Promise<boolean>;
  readonly sessionIdFactory?: () => string;
  readonly cfHomeForSession: (sessionId: string) => string;
  readonly basePort?: number;
  readonly maxPort?: number;
}

const DEFAULT_BASE_PORT = 20_000;
const DEFAULT_MAX_PORT = 20_999;

async function pickPort(
  preferred: number | undefined,
  reserved: ReadonlySet<number>,
  probe: (port: number) => Promise<boolean>,
  basePort: number,
  maxPort: number,
): Promise<number> {
  const tryOrder: number[] = [];
  if (preferred !== undefined) {
    tryOrder.push(preferred);
  }
  for (let port = basePort; port <= maxPort; port++) {
    if (port !== preferred) {
      tryOrder.push(port);
    }
  }

  for (const port of tryOrder) {
    if (reserved.has(port)) {
      continue;
    }
    const free = await probe(port);
    if (free) {
      return port;
    }
  }
  throw new CfDebuggerError(
    "PORT_UNAVAILABLE",
    `No free local port available in range ${basePort.toString()}–${maxPort.toString()}`,
  );
}

export async function registerNewSession(
  input: RegisterSessionInput,
): Promise<RegisterSessionResult> {
  return await withFileLock(stateLockPath(), async (): Promise<RegisterSessionResult> => {
    const pruneResult = await readAndPruneLocked();
    const existing = pruneResult.sessions.find((session) => matchesKey(session, input));
    if (existing) {
      return { session: existing, existing };
    }

    const reservedPorts = new Set(pruneResult.sessions.map((session) => session.localPort));
    const localPort = await pickPort(
      input.preferredPort,
      reservedPorts,
      input.portProbe,
      input.basePort ?? DEFAULT_BASE_PORT,
      input.maxPort ?? DEFAULT_MAX_PORT,
    );

    const sessionId = (input.sessionIdFactory ?? randomUUID)();
    const cfHomeDir = input.cfHomeForSession(sessionId);

    const session: ActiveSession = {
      sessionId,
      pid: process.pid,
      hostname: getHostname(),
      region: input.region,
      org: input.org,
      space: input.space,
      app: input.app,
      apiEndpoint: input.apiEndpoint,
      localPort,
      remotePort: 9229,
      cfHomeDir,
      startedAt: new Date().toISOString(),
      status: "starting",
    };

    const nextSessions: readonly ActiveSession[] = [...pruneResult.sessions, session];
    await writeState({ version: "1", sessions: nextSessions });

    return { session };
  });
}

export async function updateSessionStatus(
  sessionId: string,
  status: ActiveSession["status"],
  message?: string,
): Promise<ActiveSession | undefined> {
  return await withFileLock(stateLockPath(), async (): Promise<ActiveSession | undefined> => {
    const raw = await readStateRaw();
    let updated: ActiveSession | undefined;
    const nextSessions = raw.sessions.map((session): ActiveSession => {
      if (session.sessionId !== sessionId) {
        return session;
      }
      const base: ActiveSession = {
        sessionId: session.sessionId,
        pid: session.pid,
        hostname: session.hostname,
        region: session.region,
        org: session.org,
        space: session.space,
        app: session.app,
        apiEndpoint: session.apiEndpoint,
        localPort: session.localPort,
        remotePort: session.remotePort,
        cfHomeDir: session.cfHomeDir,
        startedAt: session.startedAt,
        status,
      };
      const next: ActiveSession = message === undefined ? base : { ...base, message };
      updated = next;
      return next;
    });

    if (updated) {
      await writeState({ version: "1", sessions: nextSessions });
    }
    return updated;
  });
}

export async function removeSession(sessionId: string): Promise<ActiveSession | undefined> {
  return await withFileLock(stateLockPath(), async (): Promise<ActiveSession | undefined> => {
    const raw = await readStateRaw();
    const target = raw.sessions.find((session) => session.sessionId === sessionId);
    if (!target) {
      return undefined;
    }
    const remaining = raw.sessions.filter((session) => session.sessionId !== sessionId);
    await writeState({ version: "1", sessions: remaining });
    return target;
  });
}
