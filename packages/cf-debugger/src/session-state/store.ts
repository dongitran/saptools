import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname as getHostname } from "node:os";
import { dirname, isAbsolute } from "node:path";
import process from "node:process";

import { resolveNodeTarget } from "../cloud-foundry/node-process.js";
import { withFileLock } from "../lock.js";
import { isSafeSessionId, stateFilePath, stateLockPath } from "../paths.js";
import { isPortListening } from "../port.js";
import { CfDebuggerError } from "../types.js";
import type { ActiveSession, SessionKey, StateFile } from "../types.js";

import { decodeStateFile } from "./decoder.js";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

async function readJsonFile(path: string): Promise<unknown> {
  let raw: string;
  try {
    await chmod(path, 0o600);
    raw = await readFile(path, "utf8");
  } catch (err: unknown) {
    if (errorCode(err) === "ENOENT") {
      return undefined;
    }
    throw err;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    process.stderr.write(
      `[cf-debugger] warning: state file at ${path} is not valid JSON; resetting to empty.\n`,
    );
    return undefined;
  }
}

async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  const parentDir = dirname(path);
  await mkdir(parentDir, { recursive: true, mode: 0o700 });
  await chmod(parentDir, 0o700);
  let renamed = false;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(tempPath, path);
    renamed = true;
    await chmod(path, 0o600);
  } finally {
    if (!renamed) {
      await unlink(tempPath).catch(() => false);
    }
  }
}

function emptyState(): StateFile {
  return { version: "2", sessions: [] };
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (errorCode(err) === "ESRCH") {
      return false;
    }
    return true;
  }
}

export function isPidOrGroupAlive(pid: number): boolean {
  if (isPidAlive(pid)) {
    return true;
  }
  return isProcessGroupAlive(pid);
}

export function isProcessGroupAlive(pid: number): boolean {
  return process.platform !== "win32" && isPidAlive(-pid);
}

async function isSessionHealthy(session: ActiveSession, host: string): Promise<boolean> {
  if (session.hostname !== host) {
    return false;
  }
  if (session.status !== "ready" && isPidAlive(session.controllerPid ?? session.pid)) {
    return true;
  }
  if (session.tunnelPid !== undefined && isPidOrGroupAlive(session.tunnelPid)) {
    return true;
  }
  return await isPortListening(session.localPort);
}

async function filterStaleSessions(
  sessions: readonly ActiveSession[],
): Promise<readonly ActiveSession[]> {
  const host = getHostname();
  const checks = await Promise.all(
    sessions.map(async (session): Promise<readonly [ActiveSession, boolean]> => [
      session,
      await isSessionHealthy(session, host),
    ]),
  );
  return checks.filter(([, healthy]) => healthy).map(([session]) => session);
}

async function readStateRaw(): Promise<StateFile> {
  const path = stateFilePath();
  const parsed = await readJsonFile(path);
  if (parsed === undefined) {
    return emptyState();
  }
  const decoded = decodeStateFile(parsed);
  if (decoded !== undefined) {
    return decoded;
  }
  process.stderr.write(
    `[cf-debugger] warning: state file at ${path} has an invalid structure; resetting to empty.\n`,
  );
  return emptyState();
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
  const host = getHostname();
  const remote = raw.sessions.filter((session) => session.hostname !== host);
  const local = raw.sessions.filter((session) => session.hostname === host);
  const pruned = await filterStaleSessions(local);
  const removed = local.filter(
    (session) => !pruned.some((active) => active.sessionId === session.sessionId),
  );

  if (removed.length > 0) {
    await writeState({ version: "2", sessions: [...remote, ...pruned] });
  }

  return { sessions: pruned, removed };
}

export async function readActiveSessions(): Promise<readonly ActiveSession[]> {
  const result = await withFileLock(stateLockPath(), readAndPruneLocked);
  return result.sessions;
}

export async function readSessionSnapshot(): Promise<readonly ActiveSession[]> {
  return await withFileLock(stateLockPath(), async (): Promise<readonly ActiveSession[]> => {
    const raw = await readStateRaw();
    return raw.sessions;
  });
}

export async function readAndPruneActiveSessions(): Promise<StateReaderResult> {
  return await withFileLock(stateLockPath(), readAndPruneLocked);
}

export function sessionKeyString(key: SessionKey): string {
  const base = `${key.region}:${key.org}:${key.space}:${key.app}`;
  if (key.process === undefined && key.instance === undefined) {
    return base;
  }
  const target = resolveNodeTarget(key);
  return `${base}:${target.process}:${target.instance.toString()}`;
}

export function matchesKey(session: SessionKey, key: SessionKey): boolean {
  const sessionTarget = resolveNodeTarget(session);
  const keyTarget = resolveNodeTarget(key);
  return (
    session.region === key.region &&
    session.org === key.org &&
    session.space === key.space &&
    session.app === key.app &&
    sessionTarget.process === keyTarget.process &&
    sessionTarget.instance === keyTarget.instance &&
    (key.apiEndpoint === undefined || session.apiEndpoint === key.apiEndpoint) &&
    (key.nodePid === undefined || sessionTarget.nodePid === keyTarget.nodePid)
  );
}

function matchesRegistrationTarget(
  session: ActiveSession,
  input: RegisterSessionInput,
  target: ReturnType<typeof resolveNodeTarget>,
): boolean {
  return matchesKey(session, {
    region: input.region,
    org: input.org,
    space: input.space,
    app: input.app,
    process: target.process,
    instance: target.instance,
    apiEndpoint: input.apiEndpoint,
  });
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
  const target = resolveNodeTarget(input);
  return await withFileLock(stateLockPath(), async (): Promise<RegisterSessionResult> => {
    const pruneResult = await readAndPruneLocked();
    const persisted = await readStateRaw();
    const host = getHostname();
    const remoteSessions = persisted.sessions.filter((session) => session.hostname !== host);
    const existing = pruneResult.sessions.find((session) => matchesRegistrationTarget(session, input, target));
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

    const session = createRegisteredSession(input, target, localPort);

    const nextSessions: readonly ActiveSession[] = [...remoteSessions, ...pruneResult.sessions, session];
    await writeState({ version: "2", sessions: nextSessions });

    return { session };
  });
}

function createRegisteredSession(
  input: RegisterSessionInput,
  target: ReturnType<typeof resolveNodeTarget>,
  localPort: number,
): ActiveSession {
  const sessionId = (input.sessionIdFactory ?? randomUUID)();
  if (!isSafeSessionId(sessionId)) {
    throw new CfDebuggerError("UNSAFE_INPUT", "Generated debugger session ID is invalid.");
  }
  const cfHomeDir = input.cfHomeForSession(sessionId);
  if (!isAbsolute(cfHomeDir)) {
    throw new CfDebuggerError("UNSAFE_INPUT", "Debugger CF home must be an absolute path.");
  }
  return {
    sessionId,
    pid: process.pid,
    controllerPid: process.pid,
    hostname: getHostname(),
    region: input.region,
    org: input.org,
    space: input.space,
    app: input.app,
    process: target.process,
    instance: target.instance,
    ...(target.nodePid === undefined ? {} : { nodePid: target.nodePid }),
    apiEndpoint: input.apiEndpoint,
    localPort,
    remotePort: 9229,
    cfHomeDir,
    startedAt: new Date().toISOString(),
    status: "starting",
  };
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
      if (status !== "stopping" && startupMutationBlocked(session)) {
        updated = session;
        return session;
      }
      if (status === "ready" && session.tunnelPid === undefined) {
        throw new CfDebuggerError(
          "SESSION_STATE_CONFLICT",
          "A debugger session cannot become ready before its tunnel PID is recorded.",
        );
      }
      const base = withoutMessage(session);
      const next: ActiveSession = message === undefined
        ? { ...base, status }
        : { ...base, status, message };
      updated = next;
      return next;
    });

    if (updated) {
      await writeState({ version: "2", sessions: nextSessions });
    }
    return updated;
  });
}

export async function updateSessionPid(
  sessionId: string,
  pid: number,
): Promise<ActiveSession | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new CfDebuggerError("UNSAFE_INPUT", "Tunnel PID must be a positive safe integer.");
  }
  return await withFileLock(stateLockPath(), async (): Promise<ActiveSession | undefined> => {
    const raw = await readStateRaw();
    let updated: ActiveSession | undefined;
    const nextSessions = raw.sessions.map((session): ActiveSession => {
      if (session.sessionId !== sessionId) {
        return session;
      }
      if (startupMutationBlocked(session)) {
        updated = session;
        return session;
      }
      const next: ActiveSession = { ...session, pid, tunnelPid: pid };
      updated = next;
      return next;
    });

    if (updated !== undefined) {
      await writeState({ version: "2", sessions: nextSessions });
    }
    return updated;
  });
}

function withoutMessage(session: ActiveSession): ActiveSession {
  const { message, ...clone } = session;
  void message;
  return clone;
}

function startupMutationBlocked(session: ActiveSession): boolean {
  return session.status === "stopping" || session.stopRequestedAt !== undefined;
}

export async function updateSessionRemoteNodePid(
  sessionId: string,
  remoteNodePid: number,
): Promise<ActiveSession | undefined> {
  resolveNodeTarget({ nodePid: remoteNodePid });
  return await withFileLock(stateLockPath(), async (): Promise<ActiveSession | undefined> => {
    const raw = await readStateRaw();
    let updated: ActiveSession | undefined;
    const nextSessions = raw.sessions.map((session): ActiveSession => {
      if (session.sessionId !== sessionId) {
        return session;
      }
      if (startupMutationBlocked(session)) {
        updated = session;
        return session;
      }
      const next: ActiveSession = { ...session, remoteNodePid };
      updated = next;
      return next;
    });
    if (updated !== undefined) {
      await writeState({ version: "2", sessions: nextSessions });
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
    await writeState({ version: "2", sessions: remaining });
    return target;
  });
}

export interface SessionStopClaim {
  readonly session: ActiveSession;
  readonly previousStatus: ActiveSession["status"];
}

export async function requestSessionStop(sessionId: string): Promise<SessionStopClaim | undefined> {
  return await withFileLock(stateLockPath(), async (): Promise<SessionStopClaim | undefined> => {
    const raw = await readStateRaw();
    const target = raw.sessions.find((session) => session.sessionId === sessionId);
    if (target === undefined) {
      return undefined;
    }
    if (target.status === "ready" || target.stopRequestedAt !== undefined) {
      return { session: target, previousStatus: target.status };
    }
    const requested: ActiveSession = { ...target, stopRequestedAt: new Date().toISOString() };
    const sessions = raw.sessions.map((session) =>
      session.sessionId === sessionId ? requested : session
    );
    await writeState({ version: "2", sessions });
    return { session: requested, previousStatus: target.status };
  });
}
