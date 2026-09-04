import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { withFileLock } from "./lock.js";
import { DEFAULT_LOG_LIMIT } from "./parser.js";
import { cfLogsSessionsDir } from "./paths.js";
import type {
  CompactSession,
  CompactSessionRef,
  CompactSessionRowLookup,
  CompactSessionSummary,
  CompactSessionTarget,
  ParsedLogRow,
} from "./types.js";

export const DEFAULT_COMPACT_SESSION_TTL_MINUTES = 60;
export const SAVED_ROW_NOT_FOUND_MESSAGE = "Saved log row not found or expired.";

export interface CompactSessionStoreOptions {
  readonly sessionsDir?: string;
  readonly now?: () => Date;
}

export interface CreateCompactSessionInput extends CompactSessionStoreOptions {
  readonly sessionId?: string;
  readonly ttlMinutes?: number;
  readonly target?: CompactSessionTarget;
  readonly rows?: readonly ParsedLogRow[];
  readonly logLimit?: number;
}

export interface AppendCompactSessionRowsInput extends CompactSessionStoreOptions {
  readonly sessionId: string;
  readonly rows: readonly ParsedLogRow[];
  readonly logLimit?: number;
}

export function formatCompactRowRef(sessionId: string, rowId: number): string {
  return `${sessionId}:${rowId.toString()}`;
}

export function parseCompactRowRef(ref: string): CompactSessionRef {
  const match = /^(?<sessionId>[a-z0-9]{6,32}):(?<rowId>\d+)$/.exec(ref.trim());
  const rowId = Number.parseInt(match?.groups?.["rowId"] ?? "", 10);
  if (match?.groups === undefined || !Number.isInteger(rowId) || rowId <= 0) {
    throw new Error("Invalid log row ref.");
  }
  return { sessionId: match.groups["sessionId"] ?? "", rowId };
}

export async function createCompactSession(
  input: CreateCompactSessionInput = {},
): Promise<CompactSession> {
  const sessionsDir = resolveSessionsDir(input.sessionsDir);
  const now = resolveNow(input.now);
  await pruneExpiredCompactSessions({
    sessionsDir,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const session = buildSession(input, now);
  await withSessionLock(sessionsDir, session.sessionId, async () => {
    await writeSession(sessionsDir, session);
  });
  return session;
}

export async function appendCompactSessionRows(
  input: AppendCompactSessionRowsInput,
): Promise<CompactSession> {
  const sessionsDir = resolveSessionsDir(input.sessionsDir);
  const now = resolveNow(input.now);
  await pruneExpiredCompactSessions({
    sessionsDir,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return await withSessionLock(sessionsDir, input.sessionId, async () => {
    const session = await readSessionOrThrow(sessionsDir, input.sessionId, now);
    const rows = boundRows(mergeRows(session.rows, input.rows), input.logLimit);
    const updated = refreshSession(session, rows, now);
    await writeSession(sessionsDir, updated);
    return updated;
  });
}

export async function readCompactSessionRef(
  ref: string,
  options: CompactSessionStoreOptions = {},
): Promise<CompactSessionRowLookup> {
  const sessionsDir = resolveSessionsDir(options.sessionsDir);
  const now = resolveNow(options.now);
  const parsedRef = parseCompactRowRef(ref);
  await pruneExpiredCompactSessions({
    sessionsDir,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const session = await readSessionOrThrow(sessionsDir, parsedRef.sessionId, now);
  const row = session.rows.find((item) => item.id === parsedRef.rowId);
  if (row === undefined) {
    throw new Error(SAVED_ROW_NOT_FOUND_MESSAGE);
  }
  return { ref: formatCompactRowRef(session.sessionId, row.id), session, row };
}

export async function listCompactSessions(
  options: CompactSessionStoreOptions = {},
): Promise<readonly CompactSessionSummary[]> {
  const sessionsDir = resolveSessionsDir(options.sessionsDir);
  await pruneExpiredCompactSessions(options);
  const sessions = await readAllSessions(sessionsDir);
  return sessions.map(toSummary).sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

export async function pruneExpiredCompactSessions(
  options: CompactSessionStoreOptions = {},
): Promise<number> {
  const sessionsDir = resolveSessionsDir(options.sessionsDir);
  const now = resolveNow(options.now);
  const files = await listSessionFiles(sessionsDir);
  let removed = 0;
  for (const file of files) {
    const session = await readSessionFile(join(sessionsDir, file));
    if (session === undefined || isExpired(session, now)) {
      await rm(join(sessionsDir, file), { force: true });
      removed += 1;
    }
  }
  return removed;
}

export async function clearCompactSessions(
  options: CompactSessionStoreOptions = {},
): Promise<number> {
  const sessionsDir = resolveSessionsDir(options.sessionsDir);
  const files = await listSessionFiles(sessionsDir);
  await Promise.all(
    files.map(async (file) => {
      await rm(join(sessionsDir, file), { force: true });
    }),
  );
  return files.length;
}

function buildSession(input: CreateCompactSessionInput, now: Date): CompactSession {
  const ttlMinutes = resolveTtlMinutes(input.ttlMinutes);
  const sessionId = input.sessionId ?? randomBytes(4).toString("hex");
  const rows = boundRows(input.rows ?? [], input.logLimit);
  return {
    version: 1,
    sessionId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: addMinutes(now, ttlMinutes).toISOString(),
    ttlMinutes,
    ...(input.target === undefined ? {} : { target: input.target }),
    rows,
  };
}

function refreshSession(
  session: CompactSession,
  rows: readonly ParsedLogRow[],
  now: Date,
): CompactSession {
  return {
    ...session,
    updatedAt: now.toISOString(),
    expiresAt: addMinutes(now, session.ttlMinutes).toISOString(),
    rows,
  };
}

async function readSessionOrThrow(
  sessionsDir: string,
  sessionId: string,
  now: Date,
): Promise<CompactSession> {
  const session = await readSessionFile(sessionPath(sessionsDir, sessionId));
  if (session === undefined || isExpired(session, now)) {
    throw new Error(SAVED_ROW_NOT_FOUND_MESSAGE);
  }
  return session;
}

async function readAllSessions(sessionsDir: string): Promise<readonly CompactSession[]> {
  const files = await listSessionFiles(sessionsDir);
  const sessions = await Promise.all(files.map(async (file) => await readSessionFile(join(sessionsDir, file))));
  return sessions.filter((session): session is CompactSession => session !== undefined);
}

async function readSessionFile(path: string): Promise<CompactSession | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isCompactSession(parsed) ? withBackfilledRows(parsed) : undefined;
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error instanceof Error ? error : new Error(String(error), { cause: error });
  }
}

async function writeSession(sessionsDir: string, session: CompactSession): Promise<void> {
  await mkdir(sessionsDir, { recursive: true });
  const path = sessionPath(sessionsDir, session.sessionId);
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempPath, path);
}

async function listSessionFiles(sessionsDir: string): Promise<readonly string[]> {
  try {
    const files = await readdir(sessionsDir);
    return files.filter((file) => file.endsWith(".json"));
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") {
      return [];
    }
    throw error instanceof Error ? error : new Error(String(error), { cause: error });
  }
}

async function withSessionLock<T>(
  sessionsDir: string,
  sessionId: string,
  work: () => Promise<T>,
): Promise<T> {
  return await withFileLock(sessionLockPath(sessionsDir, sessionId), work);
}

function mergeRows(
  existingRows: readonly ParsedLogRow[],
  appendedRows: readonly ParsedLogRow[],
): readonly ParsedLogRow[] {
  const appendedIds = new Set(appendedRows.map((row) => row.id));
  return [...existingRows.filter((row) => !appendedIds.has(row.id)), ...appendedRows];
}

function boundRows(rows: readonly ParsedLogRow[], logLimit: number | undefined): readonly ParsedLogRow[] {
  const limit = resolveLogLimit(logLimit);
  return rows.length <= limit ? rows : rows.slice(rows.length - limit);
}

function toSummary(session: CompactSession): CompactSessionSummary {
  return {
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    ttlMinutes: session.ttlMinutes,
    rowCount: session.rows.length,
    ...(session.target === undefined ? {} : { target: session.target }),
  };
}

/**
 * Sessions are validated shallowly — `rows` is only checked to be an array — so a
 * file written before `correlationId`/`vcapRequestId` existed still loads, and its
 * rows would then be missing two fields the type declares as `string`. Anything
 * that reads `.length` off them — `formatFullSavedRow`, `compactLogRows` — would
 * throw on such a row. Backfill them to "" on the way in.
 *
 * "" rather than a value recovered from `jsonPayload`: the identifier genuinely
 * was not captured for that row, and the projections that can recover it already
 * fall back to the payload themselves.
 *
 * The reverse direction needs nothing — an older binary ignores unknown row keys.
 */
function withBackfilledRows(session: CompactSession): CompactSession {
  return { ...session, rows: session.rows.map(backfillRow) };
}

function backfillRow(row: ParsedLogRow): ParsedLogRow {
  // `isCompactSession` never inspected the array's contents, so an entry here can
  // be any JSON value at all. Hand a non-object straight back rather than reading
  // through it: throwing would escape `readSessionFile` (the catch only swallows
  // ENOENT) and, because every store command prunes first, one malformed file
  // would take down list, show, create and append alike.
  if (!isRecord(row)) {
    return row;
  }
  // Read through a Partial view: `isCompactSession` never inspected a row, so the
  // declared `string` on these two is a claim about freshly parsed rows, not about
  // what a file on disk actually holds.
  const stored: Partial<ParsedLogRow> = row;
  if (typeof stored.correlationId === "string" && typeof stored.vcapRequestId === "string") {
    return row;
  }
  return {
    ...row,
    correlationId: typeof stored.correlationId === "string" ? stored.correlationId : "",
    vcapRequestId: typeof stored.vcapRequestId === "string" ? stored.vcapRequestId : "",
  };
}

function isCompactSession(value: unknown): value is CompactSession {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value["version"] === 1 &&
    typeof value["sessionId"] === "string" &&
    typeof value["createdAt"] === "string" &&
    typeof value["updatedAt"] === "string" &&
    typeof value["expiresAt"] === "string" &&
    typeof value["ttlMinutes"] === "number" &&
    Array.isArray(value["rows"])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readErrorCode(error: unknown): string {
  if (!isRecord(error)) {
    return "";
  }
  const code = error["code"];
  return typeof code === "string" ? code : "";
}

function isExpired(session: CompactSession, now: Date): boolean {
  return Date.parse(session.expiresAt) <= now.getTime();
}

function sessionPath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, `${sessionId}.json`);
}

function sessionLockPath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, `${sessionId}.lock`);
}

function resolveSessionsDir(sessionsDir: string | undefined): string {
  return sessionsDir ?? cfLogsSessionsDir();
}

function resolveNow(now: (() => Date) | undefined): Date {
  return now?.() ?? new Date();
}

function resolveTtlMinutes(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_COMPACT_SESSION_TTL_MINUTES;
}

function resolveLogLimit(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_LOG_LIMIT;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}
