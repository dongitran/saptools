import type { Dirent, Stats } from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import nodeProcess from "node:process";

import { withFileLock } from "../lock.js";
import {
  inspectListeningProcesses,
  isPortListening,
} from "../network/ports.js";
import {
  CF_DEBUGGER_HOMES_DIRNAME,
  CF_DEBUGGER_LOCK_FILENAME,
  CF_DEBUGGER_STATE_FILENAME,
  CF_DEBUGGER_STOP_INTENT_PREFIX,
  isOwnedSessionCfHomeDir,
  saptoolsDir,
  stateFilePath,
  stateLockPath,
} from "../paths.js";
import { decodeStateFileDetailed } from "../session-state/decoder.js";
import type { SessionHealthVerdict } from "../session-state/store.js";
import { inspectSessionHealth } from "../session-state/store.js";
import type {
  ActiveSession,
  StateFile,
} from "../types.js";

import { inspectProcessIdentity } from "./process-identity.js";
import { tryRemoveOwnedSessionCfHome } from "./session-home.js";

const MANAGED_PORT_MIN = 20_000;
const MANAGED_PORT_MAX = 20_999;
const PORT_SCAN_CONCURRENCY = 32;
const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1_000;
const STALE_LOCK_AGE_MS = 60 * 60 * 1_000;
const FOREIGN_OR_MALFORMED_LOCK_AGE_MS = 24 * 60 * 60 * 1_000;
const LEGACY_STATE_FILENAME = "cf-debugger-state.json";
const LEGACY_LOCK_FILENAME = "cf-debugger-state.lock";
const LEGACY_HOMES_DIRNAME = "cf-debugger-homes";

export type DoctorCleanupStatus =
  | "not-requested"
  | "not-eligible"
  | "removed"
  | "skipped"
  | "failed";

export interface DoctorSessionFinding {
  readonly session: ActiveSession;
  readonly health: SessionHealthVerdict;
}

export interface DoctorHomeFinding {
  readonly sessionId: string;
  readonly path: string;
  readonly cleanupEligible: boolean;
  readonly cleanupStatus: DoctorCleanupStatus;
}

export interface DoctorPortFinding {
  readonly port: number;
  readonly pids: readonly number[];
  readonly ownerStatus: "found" | "unverified";
  readonly reason?: string;
}

export type DoctorArtifactKind =
  | "state-temp"
  | "state-lock"
  | "state-recovery"
  | "stop-intent"
  | "corrupt-backup";

export interface DoctorArtifactFinding {
  readonly kind: DoctorArtifactKind;
  readonly path: string;
  readonly ageMs: number;
  readonly cleanupEligible: boolean;
  readonly cleanupStatus: DoctorCleanupStatus;
  readonly cleanupError?: string;
}

export interface DoctorLegacyFinding {
  readonly statePath: string;
  readonly statePresent: boolean;
  readonly homesPath: string;
  readonly homesPresent: boolean;
  readonly warning?: string;
  readonly manualRemovalCommand?: string;
}

export interface DoctorReport {
  readonly sessions: readonly DoctorSessionFinding[];
  readonly orphanHomes: readonly DoctorHomeFinding[];
  readonly unclaimedPorts: readonly DoctorPortFinding[];
  readonly artifacts: readonly DoctorArtifactFinding[];
  readonly legacy: DoctorLegacyFinding;
  readonly warnings: readonly string[];
  readonly cleanedPaths: readonly string[];
}

export interface DoctorOptions {
  readonly cleanup?: boolean;
}

interface StateReadResult {
  readonly state: StateFile;
  readonly warnings: readonly string[];
  readonly homeCleanupSafe: boolean;
}

interface LockOwner {
  readonly hostname: string;
  readonly pid: number;
  readonly processIdentity?: string;
  readonly token: string;
}

interface ArtifactCandidate {
  readonly kind: DoctorArtifactKind;
  readonly path: string;
  readonly ageMs: number;
  readonly cleanupEligible: boolean;
  readonly fingerprint: string;
  readonly sessionId?: string;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const value: unknown = Reflect.get(error, "code");
  return typeof value === "string" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyState(): StateFile {
  return { version: "2", sessions: [] };
}

async function readDoctorState(): Promise<StateReadResult> {
  let raw: string;
  try {
    raw = await readFile(stateFilePath(), "utf8");
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return { state: emptyState(), warnings: [], homeCleanupSafe: true };
    }
    return {
      state: emptyState(),
      warnings: [`Could not read debugger state: ${errorMessage(error)}`],
      homeCleanupSafe: false,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      state: emptyState(),
      warnings: ["Debugger state contains invalid JSON."],
      homeCleanupSafe: false,
    };
  }
  const decoded = decodeStateFileDetailed(parsed);
  if (decoded.kind === "invalid-file") {
    return {
      state: emptyState(),
      warnings: [`Debugger state is invalid: ${decoded.reason}.`],
      homeCleanupSafe: false,
    };
  }
  return {
    state: decoded.state,
    warnings: decoded.dropped.map((reason) => `Dropped state entry: ${reason}.`),
    homeCleanupSafe: decoded.dropped.length === 0,
  };
}

async function inspectSessions(
  sessions: readonly ActiveSession[],
): Promise<readonly DoctorSessionFinding[]> {
  const local = sessions.filter((session) => session.hostname === hostname());
  return await Promise.all(local.map(async (session): Promise<DoctorSessionFinding> => {
    try {
      return { session, health: await inspectSessionHealth(session) };
    } catch (error: unknown) {
      return {
        session,
        health: {
          status: "unverified",
          reason: `health inspection failed: ${errorMessage(error)}`,
        },
      };
    }
  }));
}

async function readDirectory(path: string): Promise<readonly Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function findOrphanHomes(
  sessions: readonly ActiveSession[],
  cleanup: boolean,
): Promise<readonly DoctorHomeFinding[]> {
  const root = join(saptoolsDir(), CF_DEBUGGER_HOMES_DIRNAME);
  const claimed = new Set(sessions.map((session) => session.sessionId));
  const entries = await readDirectory(root);
  const orphans = entries
    .filter((entry) => entry.isDirectory() && !claimed.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  return await Promise.all(orphans.map(async (entry): Promise<DoctorHomeFinding> => {
    const path = join(root, entry.name);
    const cleanupEligible = isOwnedSessionCfHomeDir(entry.name, path);
    if (!cleanup) {
      return { sessionId: entry.name, path, cleanupEligible, cleanupStatus: "not-requested" };
    }
    if (!cleanupEligible) {
      return { sessionId: entry.name, path, cleanupEligible, cleanupStatus: "not-eligible" };
    }
    const cleanupStatus = await cleanupOrphanHome(entry.name, path);
    return {
      sessionId: entry.name,
      path,
      cleanupEligible,
      cleanupStatus,
    };
  }));
}

async function cleanupOrphanHome(
  sessionId: string,
  path: string,
): Promise<DoctorCleanupStatus> {
  try {
    return await withFileLock(
      stateLockPath(),
      async (): Promise<DoctorCleanupStatus> => {
        const current = await readDoctorState();
        if (
          !current.homeCleanupSafe ||
          current.state.sessions.some((session) => session.sessionId === sessionId)
        ) {
          return "skipped";
        }
        return await tryRemoveOwnedSessionCfHome(sessionId, path)
          ? "removed"
          : "failed";
      },
    );
  } catch {
    return "failed";
  }
}

async function mapConcurrent<T, Result>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<Result | undefined>,
): Promise<readonly Result[]> {
  const results: Result[] = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) {
        return;
      }
      const result = await work(value);
      if (result !== undefined) {
        results.push(result);
      }
    }
  };
  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function unclaimedManagedPorts(sessions: readonly ActiveSession[]): readonly number[] {
  const localClaims = new Set(
    sessions
      .filter((session) => session.hostname === hostname())
      .map((session) => session.localPort),
  );
  const ports: number[] = [];
  for (let port = MANAGED_PORT_MIN; port <= MANAGED_PORT_MAX; port += 1) {
    if (!localClaims.has(port)) {
      ports.push(port);
    }
  }
  return ports;
}

async function inspectUnclaimedPort(port: number): Promise<DoctorPortFinding | undefined> {
  if (!(await isPortListening(port))) {
    return undefined;
  }
  const inspection = await inspectListeningProcesses(port);
  if (inspection.status === "found") {
    return { port, pids: inspection.pids, ownerStatus: "found" };
  }
  if (inspection.status === "unverified") {
    return {
      port,
      pids: [],
      ownerStatus: "unverified",
      reason: inspection.reason,
    };
  }
  return undefined;
}

async function findUnclaimedPorts(
  sessions: readonly ActiveSession[],
): Promise<readonly DoctorPortFinding[]> {
  const findings = await mapConcurrent(
    unclaimedManagedPorts(sessions),
    PORT_SCAN_CONCURRENCY,
    inspectUnclaimedPort,
  );
  return [...findings].sort((left, right) => left.port - right.port);
}

function artifactKind(name: string): DoctorArtifactKind | undefined {
  if (name === CF_DEBUGGER_LOCK_FILENAME) {
    return "state-lock";
  }
  if (name === `${CF_DEBUGGER_LOCK_FILENAME}.recovery`) {
    return "state-recovery";
  }
  if (
    name.startsWith(`${CF_DEBUGGER_STATE_FILENAME}.`)
    && name.endsWith(".tmp")
  ) {
    return "state-temp";
  }
  if (
    name.startsWith(CF_DEBUGGER_STOP_INTENT_PREFIX)
    && name.endsWith(".stop")
  ) {
    return "stop-intent";
  }
  return name.startsWith(`${CF_DEBUGGER_STATE_FILENAME}.corrupt-`)
    ? "corrupt-backup"
    : undefined;
}

function parseLockOwner(raw: string): LockOwner | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const ownerHostname: unknown = Reflect.get(parsed, "hostname");
  const pid: unknown = Reflect.get(parsed, "pid");
  const processIdentity: unknown = Reflect.get(parsed, "processIdentity");
  const token: unknown = Reflect.get(parsed, "token");
  if (
    typeof ownerHostname !== "string"
    || typeof pid !== "number"
    || !Number.isSafeInteger(pid)
    || pid <= 0
    || (
      processIdentity !== undefined &&
      (typeof processIdentity !== "string" || processIdentity.length === 0)
    )
    || typeof token !== "string"
  ) {
    return undefined;
  }
  return {
    hostname: ownerHostname,
    pid,
    ...(processIdentity === undefined ? {} : { processIdentity }),
    token,
  };
}

function isPidAlive(pid: number): boolean {
  try {
    nodeProcess.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) !== "ESRCH";
  }
}

async function readLockOwner(path: string): Promise<LockOwner | undefined> {
  try {
    return parseLockOwner(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function lockCleanupEligible(path: string, ageMs: number): Promise<boolean> {
  if (ageMs < STALE_LOCK_AGE_MS) {
    return false;
  }
  const owner = await readLockOwner(path);
  if (owner?.hostname === hostname()) {
    if (!isPidAlive(owner.pid)) {
      return true;
    }
    if (owner.processIdentity !== undefined) {
      const identity = await inspectProcessIdentity(owner.pid, owner.processIdentity);
      if (identity === "mismatch") {
        return true;
      }
      if (identity === "match") {
        return false;
      }
    }
    return ageMs >= FOREIGN_OR_MALFORMED_LOCK_AGE_MS;
  }
  return ageMs >= FOREIGN_OR_MALFORMED_LOCK_AGE_MS;
}

function artifactFingerprint(stats: Stats): string {
  return [
    stats.dev.toString(),
    stats.ino.toString(),
    stats.size.toString(),
    stats.mtimeMs.toString(),
  ].join(":");
}

async function inspectArtifact(
  entry: Dirent,
  now: number,
  claimedSessionIds: ReadonlySet<string>,
  stopIntentCleanupSafe: boolean,
): Promise<ArtifactCandidate | undefined> {
  const kind = artifactKind(entry.name);
  if (kind === undefined) {
    return undefined;
  }
  const path = join(saptoolsDir(), entry.name);
  const stats = await lstat(path);
  const ageMs = Math.max(0, now - stats.mtimeMs);
  const regularFile = stats.isFile();
  let sessionId: string | undefined;
  let cleanupEligible = regularFile && kind === "state-temp" && ageMs >= STALE_TEMP_AGE_MS;
  if (regularFile && kind === "stop-intent") {
    sessionId = entry.name.slice(
      CF_DEBUGGER_STOP_INTENT_PREFIX.length,
      -".stop".length,
    );
    cleanupEligible = stopIntentCleanupSafe &&
      ageMs >= STALE_TEMP_AGE_MS &&
      !claimedSessionIds.has(sessionId);
  }
  if (regularFile && (kind === "state-lock" || kind === "state-recovery")) {
    cleanupEligible = await lockCleanupEligible(path, ageMs);
  }
  return {
    kind,
    path,
    ageMs,
    cleanupEligible,
    fingerprint: artifactFingerprint(stats),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

async function candidateStillMatches(candidate: ArtifactCandidate): Promise<boolean> {
  try {
    const stats = await lstat(candidate.path);
    return artifactFingerprint(stats) === candidate.fingerprint;
  } catch {
    return false;
  }
}

async function cleanupArtifact(
  candidate: ArtifactCandidate,
): Promise<{ readonly status: DoctorCleanupStatus; readonly error?: string }> {
  if (!candidate.cleanupEligible) {
    return { status: "not-eligible" };
  }
  try {
    if (candidate.kind === "stop-intent" && candidate.sessionId !== undefined) {
      return await withFileLock(
        stateLockPath(),
        async (): Promise<{ readonly status: DoctorCleanupStatus }> => {
          const current = await readDoctorState();
          if (
            !current.homeCleanupSafe ||
            current.state.sessions.some(
              (session) => session.sessionId === candidate.sessionId,
            ) ||
            !(await candidateStillMatches(candidate))
          ) {
            return { status: "skipped" };
          }
          await unlink(candidate.path);
          return { status: "removed" };
        },
      );
    }
    if (!(await candidateStillMatches(candidate))) {
      return { status: "skipped" };
    }
    await unlink(candidate.path);
    return { status: "removed" };
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return { status: "skipped" };
    }
    return { status: "failed", error: errorMessage(error) };
  }
}

async function findArtifacts(
  cleanup: boolean,
  sessions: readonly ActiveSession[],
  stopIntentCleanupSafe: boolean,
): Promise<readonly DoctorArtifactFinding[]> {
  const entries = await readDirectory(saptoolsDir());
  const claimedSessionIds = new Set(sessions.map((session) => session.sessionId));
  const inspected = await Promise.all(
    entries.map(async (entry): Promise<ArtifactCandidate | undefined> =>
      await inspectArtifact(entry, Date.now(), claimedSessionIds, stopIntentCleanupSafe)
    ),
  );
  const candidates = inspected.filter(
    (candidate): candidate is ArtifactCandidate => candidate !== undefined,
  ).sort((left, right) => left.path.localeCompare(right.path));
  const findings: DoctorArtifactFinding[] = [];
  for (const candidate of candidates) {
    const result = cleanup
      ? await cleanupArtifact(candidate)
      : {
        status: candidate.cleanupEligible ? "not-requested" : "not-eligible",
      } satisfies { readonly status: DoctorCleanupStatus };
    findings.push({
      kind: candidate.kind,
      path: candidate.path,
      ageMs: candidate.ageMs,
      cleanupEligible: candidate.cleanupEligible,
      cleanupStatus: result.status,
      ...(result.error === undefined ? {} : { cleanupError: result.error }),
    });
  }
  return findings;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function findLegacyArtifacts(): Promise<DoctorLegacyFinding> {
  const statePath = join(saptoolsDir(), LEGACY_STATE_FILENAME);
  const lockPath = join(saptoolsDir(), LEGACY_LOCK_FILENAME);
  const homesPath = join(saptoolsDir(), LEGACY_HOMES_DIRNAME);
  const [statePresent, homesPresent] = await Promise.all([
    pathExists(statePath),
    pathExists(homesPath),
  ]);
  if (!statePresent && !homesPresent) {
    return { statePath, statePresent, homesPath, homesPresent };
  }
  const command = `rm -rf -- ${shellQuote(homesPath)} ${shellQuote(statePath)} ${shellQuote(lockPath)}`;
  return {
    statePath,
    statePresent,
    homesPath,
    homesPresent,
    warning:
      "Legacy v1 debugger homes may contain live CF refresh and access tokens. " +
      "Confirm no v1 tunnel is running before removing them.",
    manualRemovalCommand: command,
  };
}

function reportWarnings(
  stateWarnings: readonly string[],
  orphanHomes: readonly DoctorHomeFinding[],
  unclaimedPorts: readonly DoctorPortFinding[],
  legacy: DoctorLegacyFinding,
): readonly string[] {
  const warnings = [...stateWarnings];
  if (orphanHomes.length > 0) {
    warnings.push(`${orphanHomes.length.toString()} orphaned v2 CF home(s) found.`);
  }
  if (unclaimedPorts.length > 0) {
    warnings.push(`${unclaimedPorts.length.toString()} unclaimed managed-port listener(s) found.`);
  }
  if (legacy.warning !== undefined) {
    warnings.push(legacy.warning);
  }
  return warnings;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cleanup = options.cleanup === true;
  const stateResult = await readDoctorState();
  const homeCleanup = cleanup && stateResult.homeCleanupSafe;
  const [sessions, orphanHomes, unclaimedPorts, artifacts, legacy] = await Promise.all([
    inspectSessions(stateResult.state.sessions),
    findOrphanHomes(stateResult.state.sessions, homeCleanup),
    findUnclaimedPorts(stateResult.state.sessions),
    findArtifacts(cleanup, stateResult.state.sessions, stateResult.homeCleanupSafe),
    findLegacyArtifacts(),
  ]);
  const cleanedPaths = [
    ...orphanHomes
      .filter((finding) => finding.cleanupStatus === "removed")
      .map((finding) => finding.path),
    ...artifacts
      .filter((finding) => finding.cleanupStatus === "removed")
      .map((finding) => finding.path),
  ];
  return {
    sessions,
    orphanHomes,
    unclaimedPorts,
    artifacts,
    legacy,
    warnings: [
      ...reportWarnings(stateResult.warnings, orphanHomes, unclaimedPorts, legacy),
      ...(cleanup && !stateResult.homeCleanupSafe
        ? [
            "Skipped orphan-home and stop-intent cleanup because debugger state was incomplete or invalid.",
          ]
        : []),
    ],
    cleanedPaths,
  };
}
