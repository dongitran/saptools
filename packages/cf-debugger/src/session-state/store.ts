import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname as getHostname } from "node:os";
import { dirname, isAbsolute } from "node:path";
import nodeProcess from "node:process";

import {
  DEFAULT_NODE_INSPECTOR_PORT,
  resolveNodeTarget,
} from "../cloud-foundry/node-process.js";
import { MAX_STARTUP_TIMEOUT_MS } from "../debug-session/constants.js";
import { readProcessIdentity } from "../debug-session/process-identity.js";
import { validateCfCliOperand } from "../input-validation.js";
import { withFileLock } from "../lock.js";
import {
  isSafeSessionId,
  stateFilePath,
  stateLockPath,
} from "../paths.js";
import { CfDebuggerError } from "../types.js";
import type { ActiveSession, SessionKey, StateFile } from "../types.js";

import { decodeStateFileDetailed } from "./decoder.js";
import { inspectSessionHealth } from "./health.js";
import { writeSessionStopIntent } from "./stop-intent.js";

export {
  inspectSessionHealth,
  isPidAlive,
  isPidOrGroupAlive,
  isProcessGroupAlive,
} from "./health.js";
export type {
  SessionHealthStatus,
  SessionHealthVerdict,
} from "./health.js";

const DEFAULT_BASE_PORT = 20_000;
const DEFAULT_MAX_PORT = 20_999;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

async function readFileIfPresent(path: string): Promise<string | undefined> {
  try {
    await chmod(path, 0o600);
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
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
    // Atomicity is required here; crash durability across power loss is not.
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

function corruptBackupPath(path: string): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return `${path}.corrupt-${timestamp}-${randomUUID()}`;
}

async function preserveCorruptState(path: string, reason: string): Promise<string> {
  const backup = corruptBackupPath(path);
  await rename(path, backup);
  await chmod(backup, 0o600);
  nodeProcess.stderr.write(
    `[cf-debugger] warning: preserved invalid state at ${backup} (${reason}).\n`,
  );
  return backup;
}

async function resetInvalidState(path: string, reason: string): Promise<StateFile> {
  await preserveCorruptState(path, reason);
  const state = emptyState();
  await writeJsonFileAtomic(path, state);
  return state;
}

async function readStateRaw(): Promise<StateFile> {
  const path = stateFilePath();
  const raw = await readFileIfPresent(path);
  if (raw === undefined) {
    return emptyState();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return await resetInvalidState(path, "invalid JSON");
  }
  const decoded = decodeStateFileDetailed(parsed);
  if (decoded.kind === "invalid-file") {
    return await resetInvalidState(path, decoded.reason);
  }
  if (decoded.dropped.length > 0) {
    await preserveCorruptState(path, decoded.dropped.join("; "));
    await writeJsonFileAtomic(path, decoded.state);
    nodeProcess.stderr.write(
      `[cf-debugger] warning: dropped ${decoded.dropped.length.toString()} invalid state ` +
        `entr${decoded.dropped.length === 1 ? "y" : "ies"}; valid sessions were retained.\n`,
    );
  }
  return decoded.state;
}

async function writeState(state: StateFile): Promise<void> {
  await writeJsonFileAtomic(stateFilePath(), state);
}

export interface StateReaderResult {
  readonly sessions: readonly ActiveSession[];
  readonly removed: readonly ActiveSession[];
}

export interface StateAccessOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface PruneInspection {
  readonly snapshotById: ReadonlyMap<string, ActiveSession>;
  readonly staleIds: ReadonlySet<string>;
}

function samePersistedSession(left: ActiveSession, right: ActiveSession): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function inspectPruneCandidates(
  raw: StateFile,
  signal?: AbortSignal,
): Promise<PruneInspection> {
  const host = getHostname();
  const local = raw.sessions.filter((session) => session.hostname === host);
  const verdicts = await Promise.all(local.map(async (session) => ({
    session,
    verdict: await inspectSessionHealth(session, host, signal),
  })));
  return {
    snapshotById: new Map(local.map((session) => [session.sessionId, session])),
    staleIds: new Set(
      verdicts
        .filter(({ verdict }) => verdict.status === "stale")
        .map(({ session }) => session.sessionId),
    ),
  };
}

async function persistPruneInspection(
  inspection: PruneInspection,
  signal?: AbortSignal,
): Promise<StateReaderResult> {
  const raw = await readStateRaw();
  const host = getHostname();
  const removed: ActiveSession[] = [];
  const sessions: ActiveSession[] = [];
  for (const session of raw.sessions.filter((entry) => entry.hostname === host)) {
    const snapshot = inspection.snapshotById.get(session.sessionId);
    if (
      snapshot === undefined ||
      !inspection.staleIds.has(session.sessionId) ||
      !samePersistedSession(snapshot, session)
    ) {
      sessions.push(session);
      continue;
    }
    const verdict = await inspectSessionHealth(session, host, signal);
    if (verdict.status === "stale") {
      removed.push(session);
    } else {
      sessions.push(session);
    }
  }
  if (removed.length > 0) {
    const remote = raw.sessions.filter((session) => session.hostname !== host);
    await writeState({ version: "2", sessions: [...remote, ...sessions] });
  }
  return { sessions, removed };
}

async function inspectAndPrune(
  options?: StateAccessOptions,
): Promise<StateReaderResult> {
  const snapshot = await withFileLock(
    stateLockPath(),
    readStateRaw,
    options,
  );
  const inspection = await inspectPruneCandidates(snapshot, options?.signal);
  return await withFileLock(
    stateLockPath(),
    async (): Promise<StateReaderResult> =>
      await persistPruneInspection(inspection, options?.signal),
    options,
  );
}

export async function readActiveSessions(): Promise<readonly ActiveSession[]> {
  const result = await inspectAndPrune();
  return result.sessions;
}

export async function readSessionSnapshot(
  options?: StateAccessOptions,
): Promise<readonly ActiveSession[]> {
  return await withFileLock(stateLockPath(), async (): Promise<readonly ActiveSession[]> => {
    return (await readStateRaw()).sessions;
  }, options);
}

export async function readAndPruneActiveSessions(
  options?: StateAccessOptions,
): Promise<StateReaderResult> {
  return await inspectAndPrune(options);
}

export function sessionKeyString(key: SessionKey): string {
  const base = `${key.region}:${key.org}:${key.space}:${key.app}`;
  if (key.process === undefined && key.instance === undefined) {
    return base;
  }
  const target = resolveNodeTarget(key);
  return `${base}:${target.process}:${target.instance.toString()}`;
}

function matchesSelectedNodePid(
  session: SessionKey,
  requestedNodePid: number | undefined,
): boolean {
  if (requestedNodePid === undefined) {
    return true;
  }
  const remoteNodePid: unknown = Reflect.get(session, "remoteNodePid");
  return session.nodePid === requestedNodePid || remoteNodePid === requestedNodePid;
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
    matchesSelectedNodePid(session, keyTarget.nodePid)
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
  readonly remotePort?: number;
  readonly startupTimeoutMs?: number;
  readonly portProbe: (port: number) => Promise<boolean>;
  readonly sessionIdFactory?: () => string;
  readonly cfHomeForSession: (sessionId: string) => string;
  readonly basePort?: number;
  readonly maxPort?: number;
  readonly stateAccess?: StateAccessOptions;
}

interface PortRange {
  readonly basePort: number;
  readonly maxPort: number;
}

function portCandidates(
  preferred: number | undefined,
  range: PortRange,
  scanOffset: number,
): readonly number[] {
  const candidates = preferred === undefined ? [] : [preferred];
  const size = range.maxPort - range.basePort + 1;
  for (let index = 0; index < size; index += 1) {
    const port = range.basePort + ((scanOffset + index) % size);
    if (port !== preferred) {
      candidates.push(port);
    }
  }
  return candidates;
}

async function pickPort(
  preferred: number | undefined,
  reserved: ReadonlySet<number>,
  probe: (port: number) => Promise<boolean>,
  range: PortRange,
  scanOffset: number,
): Promise<number> {
  for (const port of portCandidates(preferred, range, scanOffset)) {
    if (!reserved.has(port) && await probe(port)) {
      return port;
    }
  }
  throw new CfDebuggerError(
    "PORT_UNAVAILABLE",
    `No free local port available in range ` +
      `${range.basePort.toString()}–${range.maxPort.toString()}`,
  );
}

interface RegistrationCandidate {
  readonly candidate?: number;
  readonly existing?: ActiveSession;
}

async function selectRegistrationCandidate(
  input: RegisterSessionInput,
  target: ReturnType<typeof resolveNodeTarget>,
  excluded: ReadonlySet<number>,
  range: PortRange,
  scanOffset: number,
): Promise<RegistrationCandidate> {
  await readAndPruneActiveSessions(input.stateAccess);
  return await withFileLock(stateLockPath(), async (): Promise<RegistrationCandidate> => {
    const raw = await readStateRaw();
    const local = raw.sessions.filter((session) => session.hostname === getHostname());
    const existing = local.find((session) =>
      matchesRegistrationTarget(session, input, target)
    );
    if (existing !== undefined) {
      return { existing };
    }
    const reserved = new Set([
      ...local.map((session) => session.localPort),
      ...excluded,
    ]);
    return {
      candidate: await pickPort(
        input.preferredPort,
        reserved,
        (): Promise<boolean> => Promise.resolve(true),
        range,
        scanOffset,
      ),
    };
  }, input.stateAccess);
}

function validateTcpPort(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65_535) {
    throw new CfDebuggerError("UNSAFE_INPUT", `${label} must be from 1 to 65535.`);
  }
}

function validatePortRange(input: RegisterSessionInput): PortRange {
  const basePort = input.basePort ?? DEFAULT_BASE_PORT;
  const maxPort = input.maxPort ?? DEFAULT_MAX_PORT;
  validateTcpPort(basePort, "Local port range start");
  validateTcpPort(maxPort, "Local port range end");
  if (basePort > maxPort) {
    throw new CfDebuggerError(
      "UNSAFE_INPUT",
      "Local port range start must not exceed its end.",
    );
  }
  if (input.preferredPort !== undefined) {
    validateTcpPort(input.preferredPort, "Preferred local port");
  }
  return { basePort, maxPort };
}

function validateSessionInput(input: RegisterSessionInput): PortRange {
  validateCfCliOperand(input.region, "Region");
  validateCfCliOperand(input.org, "Cloud Foundry org");
  validateCfCliOperand(input.space, "Cloud Foundry space");
  validateCfCliOperand(input.app, "Cloud Foundry app");
  validateCfCliOperand(input.apiEndpoint, "Cloud Foundry API endpoint");
  const remotePort = input.remotePort ?? DEFAULT_NODE_INSPECTOR_PORT;
  validateTcpPort(remotePort, "Remote inspector port");
  if (
    input.startupTimeoutMs !== undefined &&
    (
      !Number.isSafeInteger(input.startupTimeoutMs) ||
      input.startupTimeoutMs <= 0 ||
      input.startupTimeoutMs > MAX_STARTUP_TIMEOUT_MS
    )
  ) {
    throw new CfDebuggerError("UNSAFE_INPUT", "Persisted startup timeout is outside the supported range.");
  }
  return validatePortRange(input);
}

function registrationScanOffset(
  input: RegisterSessionInput,
  target: ReturnType<typeof resolveNodeTarget>,
  range: PortRange,
): number {
  const identity = JSON.stringify([
    input.apiEndpoint,
    input.region,
    input.org,
    input.space,
    input.app,
    target.process,
    target.instance,
  ]);
  const hash = createHash("sha256").update(identity).digest().readUInt32BE(0);
  return hash % (range.maxPort - range.basePort + 1);
}

function createRegisteredSession(
  input: RegisterSessionInput,
  target: ReturnType<typeof resolveNodeTarget>,
  localPort: number,
  controllerProcessIdentity: string | undefined,
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
    pid: nodeProcess.pid,
    controllerPid: nodeProcess.pid,
    ...(controllerProcessIdentity === undefined ? {} : { controllerProcessIdentity }),
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
    remotePort: input.remotePort ?? DEFAULT_NODE_INSPECTOR_PORT,
    cfHomeDir,
    startedAt: new Date().toISOString(),
    status: "starting",
    ...(input.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: input.startupTimeoutMs }),
  };
}

async function persistRegistration(
  input: RegisterSessionInput,
  target: ReturnType<typeof resolveNodeTarget>,
  candidate: number,
  controllerProcessIdentity: string | undefined,
): Promise<RegisterSessionResult | undefined> {
  await readAndPruneActiveSessions(input.stateAccess);
  return await withFileLock(stateLockPath(), async (): Promise<RegisterSessionResult | undefined> => {
    const raw = await readStateRaw();
    const local = raw.sessions.filter((session) => session.hostname === getHostname());
    const existing = local.find((session) =>
      matchesRegistrationTarget(session, input, target)
    );
    if (existing !== undefined) {
      return { session: existing, existing };
    }
    const reserved = local.some((session) => session.localPort === candidate);
    if (reserved || !(await input.portProbe(candidate))) {
      return undefined;
    }
    const session = createRegisteredSession(input, target, candidate, controllerProcessIdentity);
    await writeState({
      version: "2",
      sessions: [...raw.sessions, session],
    });
    return { session };
  }, input.stateAccess);
}

export async function registerNewSession(
  input: RegisterSessionInput,
): Promise<RegisterSessionResult> {
  const range = validateSessionInput(input);
  const target = resolveNodeTarget(input);
  const scanOffset = registrationScanOffset(input, target, range);
  const controllerIdentity = await readProcessIdentity(
    nodeProcess.pid,
    input.stateAccess?.signal,
  );
  const excluded = new Set<number>();
  const maximumAttempts = range.maxPort - range.basePort + 2;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const selection = await selectRegistrationCandidate(
      input,
      target,
      excluded,
      range,
      scanOffset,
    );
    if (selection.existing !== undefined) {
      return { session: selection.existing, existing: selection.existing };
    }
    const candidate = selection.candidate;
    if (candidate === undefined || !(await input.portProbe(candidate))) {
      if (candidate !== undefined) {
        excluded.add(candidate);
      }
      continue;
    }
    const result = await persistRegistration(input, target, candidate, controllerIdentity);
    if (result !== undefined) {
      return result;
    }
    excluded.add(candidate);
  }
  throw new CfDebuggerError("PORT_UNAVAILABLE", "No free local debugger port remained available.");
}

function withoutMessage(session: ActiveSession): ActiveSession {
  const { message, ...clone } = session;
  void message;
  return clone;
}

function startupMutationBlocked(session: ActiveSession): boolean {
  return session.status === "stopping" || session.stopRequestedAt !== undefined;
}

function replaceSession(
  sessions: readonly ActiveSession[],
  replacement: ActiveSession,
): readonly ActiveSession[] {
  return sessions.map((session) =>
    session.sessionId === replacement.sessionId ? replacement : session
  );
}

export async function updateSessionStatus(
  sessionId: string,
  status: ActiveSession["status"],
  message?: string,
  access?: StateAccessOptions,
): Promise<ActiveSession | undefined> {
  return await withFileLock(stateLockPath(), async (): Promise<ActiveSession | undefined> => {
    const raw = await readStateRaw();
    const target = raw.sessions.find((session) => session.sessionId === sessionId);
    if (target === undefined || (status !== "stopping" && startupMutationBlocked(target))) {
      return target;
    }
    if (status === "ready" && target.tunnelPid === undefined) {
      throw new CfDebuggerError(
        "SESSION_STATE_CONFLICT",
        "A debugger session cannot become ready before its tunnel PID is recorded.",
      );
    }
    const base = withoutMessage(target);
    const next: ActiveSession = message === undefined
      ? { ...base, status }
      : { ...base, status, message };
    if (JSON.stringify(next) !== JSON.stringify(target)) {
      await writeState({ version: "2", sessions: replaceSession(raw.sessions, next) });
    }
    return next;
  }, access);
}

export async function updateSessionPid(
  sessionId: string,
  pid: number,
  access?: StateAccessOptions,
): Promise<ActiveSession | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new CfDebuggerError("UNSAFE_INPUT", "Tunnel PID must be a positive safe integer.");
  }
  const tunnelProcessIdentity = await readProcessIdentity(pid, access?.signal);
  return await withFileLock(stateLockPath(), async (): Promise<ActiveSession | undefined> => {
    const raw = await readStateRaw();
    const target = raw.sessions.find((session) => session.sessionId === sessionId);
    if (target === undefined || startupMutationBlocked(target)) {
      return target;
    }
    const { tunnelProcessIdentity: previousIdentity, ...base } = target;
    void previousIdentity;
    const next: ActiveSession = {
      ...base,
      pid,
      tunnelPid: pid,
      ...(tunnelProcessIdentity === undefined ? {} : { tunnelProcessIdentity }),
    };
    if (JSON.stringify(next) !== JSON.stringify(target)) {
      await writeState({ version: "2", sessions: replaceSession(raw.sessions, next) });
    }
    return next;
  }, access);
}

export async function updateSessionRemoteNodePid(
  sessionId: string,
  remoteNodePid: number,
  access?: StateAccessOptions,
): Promise<ActiveSession | undefined> {
  resolveNodeTarget({ nodePid: remoteNodePid });
  return await withFileLock(stateLockPath(), async (): Promise<ActiveSession | undefined> => {
    const raw = await readStateRaw();
    const target = raw.sessions.find((session) => session.sessionId === sessionId);
    if (target === undefined || startupMutationBlocked(target)) {
      return target;
    }
    const next: ActiveSession = { ...target, remoteNodePid };
    if (target.remoteNodePid !== remoteNodePid) {
      await writeState({ version: "2", sessions: replaceSession(raw.sessions, next) });
    }
    return next;
  }, access);
}

export async function removeSession(sessionId: string): Promise<ActiveSession | undefined> {
  return await withFileLock(stateLockPath(), async (): Promise<ActiveSession | undefined> => {
    const raw = await readStateRaw();
    const target = raw.sessions.find((session) => session.sessionId === sessionId);
    if (target === undefined) {
      return undefined;
    }
    await writeState({
      version: "2",
      sessions: raw.sessions.filter((session) => session.sessionId !== sessionId),
    });
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
    await writeSessionStopIntent(sessionId);
    if (target.stopRequestedAt !== undefined) {
      return { session: target, previousStatus: target.status };
    }
    const requested: ActiveSession = { ...target, stopRequestedAt: new Date().toISOString() };
    await writeState({
      version: "2",
      sessions: raw.sessions.map((session) =>
        session.sessionId === sessionId ? requested : session
      ),
    });
    return { session: requested, previousStatus: target.status };
  });
}
