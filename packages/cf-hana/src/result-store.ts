import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_RESULT_TTL_MINUTES,
  MAX_RESULT_STORE_BYTES,
} from "./config.js";
import { CfHanaError } from "./errors.js";
import type {
  HanaClientInfo,
  QueryResult,
  QueryResultColumn,
  QueryRow,
  SqlParam,
  StatementKind,
} from "./types.js";

const RESULT_REF_PATTERN = /^q[0-9a-f]{8}$/;
const MANIFEST_FILE_NAME = "manifest.json";
/** The largest absolute millisecond value a `Date` can hold; beyond it, `new Date(v)` is invalid. */
const MAX_DATE_MILLIS = 8_640_000_000_000_000;

type StoredCell =
  | { readonly kind: "null" }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "date"; readonly value: string }
  | { readonly kind: "buffer"; readonly value: string };

interface StoredResult {
  readonly columns: readonly QueryResultColumn[];
  readonly rows: readonly (readonly StoredCell[])[];
  readonly rowCount: number;
  readonly statement: StatementKind;
  readonly truncated: boolean;
  readonly elapsedMs: number;
}

interface StoredResultSession {
  readonly version: 1;
  readonly ref: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly ttlMinutes: number;
  readonly info: HanaClientInfo;
  readonly result: StoredResult;
}

export interface CreateResultSessionInput {
  readonly result: QueryResult;
  readonly info: HanaClientInfo;
  readonly ttlMinutes?: number;
}

export interface ResultStoreOptions {
  readonly saptoolsRoot?: string;
  readonly now?: () => Date;
  readonly ref?: string;
  readonly maxBytes?: number;
}

export interface ResultSession {
  readonly ref: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly ttlMinutes: number;
  readonly info: HanaClientInfo;
  readonly result: QueryResult;
  readonly directory: string;
  readonly path: string;
}

export interface ResultSessionSummary {
  readonly ref: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly truncated: boolean;
}

/**
 * What one prune sweep did. `retained` counts sessions deliberately left behind
 * because this version could not read them — an unreadable or unrecognized
 * manifest, or a directory whose emptiness could not be established — and
 * `failed` counts expired sessions that could not be deleted — both are silent by design
 * everywhere except `result prune`, the command whose job is to report on the
 * store.
 */
export interface PruneOutcome {
  readonly removed: number;
  readonly failed: number;
  /**
   * Refs left in place because this version could not read them. Carried as
   * refs rather than a count because a count is not actionable: a retained
   * session is omitted from `result list` and no command removes one, so naming
   * it is the only way a user can find the file and decide what to do with it.
   */
  readonly retainedRefs: readonly string[];
}

function resultsRoot(saptoolsRoot?: string): string {
  return join(saptoolsRoot ?? join(homedir(), ".saptools"), "cf-hana", "results");
}

function sessionDirectory(ref: string, saptoolsRoot?: string): string {
  return join(resultsRoot(saptoolsRoot), ref);
}

function manifestPath(ref: string, saptoolsRoot?: string): string {
  return join(sessionDirectory(ref, saptoolsRoot), MANIFEST_FILE_NAME);
}

function encodeCell(value: SqlParam): StoredCell {
  if (value === null) {
    return { kind: "null" };
  }
  if (Buffer.isBuffer(value)) {
    return { kind: "buffer", value: value.toString("base64") };
  }
  if (value instanceof Date) {
    return { kind: "date", value: value.toISOString() };
  }
  if (typeof value === "string") {
    return { kind: "string", value };
  }
  if (typeof value === "number") {
    return { kind: "number", value };
  }
  return { kind: "boolean", value };
}

function decodeCell(cell: StoredCell): SqlParam {
  switch (cell.kind) {
    case "null":
      return null;
    case "buffer":
      return Buffer.from(cell.value, "base64");
    case "date":
      return new Date(cell.value);
    case "string":
      return cell.value;
    case "number":
      return cell.value;
    case "boolean":
      return cell.value;
  }
}

function assertUniqueColumns(columns: readonly QueryResultColumn[]): void {
  const names = new Set<string>();
  for (const column of columns) {
    if (names.has(column.name)) {
      throw new CfHanaError(
        "CONFIG",
        `Saved results require unique SQL aliases; duplicate column "${column.name}"`,
      );
    }
    names.add(column.name);
  }
}

function encodeResult(result: QueryResult): StoredResult {
  assertUniqueColumns(result.columns);
  return {
    columns: result.columns,
    rows: result.rows.map((row) =>
      result.columns.map((column) => encodeCell(row[column.name] ?? null)),
    ),
    rowCount: result.rowCount,
    statement: result.statement,
    truncated: result.truncated,
    elapsedMs: result.elapsedMs,
  };
}

function decodeResult(result: StoredResult): QueryResult {
  const rows: QueryRow[] = result.rows.map((cells) => {
    const row: QueryRow = {};
    let index = 0;
    for (const column of result.columns) {
      row[column.name] = decodeCell(cells[index] ?? { kind: "null" });
      index += 1;
    }
    return row;
  });
  return { ...result, rows };
}

function resolveRef(value: string | undefined): string {
  const ref = value ?? `q${randomBytes(4).toString("hex")}`;
  if (!RESULT_REF_PATTERN.test(ref)) {
    throw new CfHanaError("CONFIG", "Invalid saved result ref");
  }
  return ref;
}

function resolveTtl(value: number | undefined): number {
  const ttl = value ?? DEFAULT_RESULT_TTL_MINUTES;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    throw new CfHanaError("CONFIG", "Result TTL must be a positive safe integer");
  }
  return ttl;
}

function toStoredSession(
  input: CreateResultSessionInput,
  ref: string,
  now: Date,
): StoredResultSession {
  const ttlMinutes = resolveTtl(input.ttlMinutes);
  return {
    version: 1,
    ref,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
    ttlMinutes,
    info: input.info,
    result: encodeResult(input.result),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shape check only — deliberately not a validity check. A manifest whose
 * `expiresAt` is a string but not a real instant still passes here, because
 * expiry is resolved separately (see `resolveExpiryMillis`); rejecting it as
 * unrecognized instead would move it onto the retain path, where no TTL could
 * ever reap it.
 */
function isStoredSession(value: unknown): value is StoredResultSession {
  if (!isRecord(value) || !isRecord(value["result"]) || !isRecord(value["info"])) {
    return false;
  }
  const result = value["result"];
  return (
    value["version"] === 1 &&
    typeof value["ref"] === "string" &&
    typeof value["createdAt"] === "string" &&
    typeof value["expiresAt"] === "string" &&
    typeof value["ttlMinutes"] === "number" &&
    Array.isArray(result["columns"]) &&
    Array.isArray(result["rows"])
  );
}

/**
 * Why a stored session could not be returned. The distinction is load-bearing:
 * prune may delete on `absent`, but must never delete on `unreadable` (a
 * transient EACCES or EIO leaves the data itself intact) or on `unrecognized`
 * (a manifest written by a newer cf-hana, or a partial write worth keeping for
 * inspection). Collapsing all three into one "missing" answer is what used to
 * make a nominally read-only `result list` destroy a saved query result.
 */
type SessionReadFailure = "absent" | "unreadable" | "unrecognized";

type SessionRead =
  | { readonly ok: true; readonly session: StoredResultSession }
  | { readonly ok: false; readonly failure: SessionReadFailure };

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function readStoredSession(path: string): Promise<SessionRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return { ok: false, failure: isMissingPathError(error) ? "absent" : "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, failure: "unrecognized" };
  }
  return isStoredSession(parsed) ? { ok: true, session: parsed } : { ok: false, failure: "unrecognized" };
}

/**
 * The instant a session stops being readable, or `undefined` when this version
 * cannot establish one at all.
 *
 * `createResultSession` always writes a parseable `expiresAt`, so an
 * unparseable one means the manifest was damaged, or was written by a version
 * that encodes timestamps differently. `createdAt` plus `ttlMinutes` is tried
 * next, and anything still not datable returns `undefined` — which callers treat
 * as "retain and report", never as "expired". Deleting a manifest whose expiry cannot be established
 * would destroy rows this version can read perfectly well, and would single out
 * the one unreadable case that *is* recoverable.
 *
 * The derived value is bounded by what a `Date` can hold, not by what a float can hold. A `Date`
 * holds at most ±8.64e15 ms, while `Number.isSafeInteger` admits a `ttlMinutes`
 * whose product reaches 5.4e20 — a finite expiry no clock can ever reach, which
 * made such a session immortal *and* uncounted.
 */
function resolveExpiryMillis(session: StoredResultSession): number | undefined {
  const explicit = Date.parse(session.expiresAt);
  if (Number.isFinite(explicit)) {
    return explicit;
  }
  const created = Date.parse(session.createdAt);
  if (!Number.isFinite(created) || !Number.isSafeInteger(session.ttlMinutes) || session.ttlMinutes <= 0) {
    return undefined;
  }
  const derived = created + session.ttlMinutes * 60_000;
  return Math.abs(derived) > MAX_DATE_MILLIS ? undefined : derived;
}

function readFailureError(ref: string, failure: SessionReadFailure, saptoolsRoot?: string): CfHanaError {
  const path = manifestPath(ref, saptoolsRoot);
  switch (failure) {
    case "absent":
      return new CfHanaError("QUERY", "Saved result not found or expired");
    case "unreadable":
      return new CfHanaError(
        "RESULT_UNREADABLE",
        `Saved result "${ref}" exists but could not be read; check permissions on ${path}`,
      );
    case "unrecognized":
      return new CfHanaError(
        "RESULT_UNREADABLE",
        `Saved result "${ref}" is not in a format this version of cf-hana understands. ` +
          `It has been left in place at ${path} — a newer cf-hana may be able to read it.`,
      );
  }
}

/**
 * A ref directory with no manifest at all is either a crashed save or a layout
 * this version does not know. An empty one is safe to reclaim; one holding other
 * files is retained, so that a manifest stored under a different name — by a
 * future release, or by a newer binary on the same machine — can never be
 * mistaken for garbage and deleted.
 */
async function isEmptyDirectory(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch {
    return false;
  }
}

/**
 * `ref` is the directory name, not `stored.ref`. The two can disagree — only
 * the directory name is addressable, so deriving `directory`/`path` from the
 * manifest's own copy pointed them at a location that may not exist.
 */
function toSession(stored: StoredResultSession, ref: string, saptoolsRoot?: string): ResultSession {
  return {
    ...stored,
    ref,
    result: decodeResult(stored.result),
    directory: sessionDirectory(ref, saptoolsRoot),
    path: manifestPath(ref, saptoolsRoot),
  };
}

async function listSessionRefs(saptoolsRoot?: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(resultsRoot(saptoolsRoot), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && RESULT_REF_PATTERN.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/** Save one exact CLI SELECT result and return its temporary ref. */
export async function createResultSession(
  input: CreateResultSessionInput,
  options: ResultStoreOptions = {},
): Promise<ResultSession> {
  await pruneBestEffort(options);
  const ref = resolveRef(options.ref);
  const stored = toStoredSession(input, ref, options.now?.() ?? new Date());
  const serialized = `${JSON.stringify(stored)}\n`;
  if (Buffer.byteLength(serialized) > (options.maxBytes ?? MAX_RESULT_STORE_BYTES)) {
    throw new CfHanaError("CONFIG", "Saved result exceeds the storage limit");
  }

  const root = resultsRoot(options.saptoolsRoot);
  const finalDirectory = sessionDirectory(ref, options.saptoolsRoot);
  const tempDirectory = `${finalDirectory}.tmp-${process.pid.toString()}`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await rm(tempDirectory, { recursive: true, force: true });
  await mkdir(tempDirectory, { mode: 0o700 });
  try {
    await writeFile(join(tempDirectory, MANIFEST_FILE_NAME), serialized, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempDirectory, finalDirectory);
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
  return toSession(stored, ref, options.saptoolsRoot);
}

/** Attempt an advisory result save without turning a successful query into a failure. */
export async function tryCreateResultSession(
  input: CreateResultSessionInput,
  options: ResultStoreOptions = {},
): Promise<ResultSession | undefined> {
  try {
    return await createResultSession(input, options);
  } catch {
    return void 0;
  }
}

/** Read one active saved result by ref. */
export async function readResultSession(
  ref: string,
  options: ResultStoreOptions = {},
): Promise<ResultSession> {
  const resolvedRef = resolveRef(ref);
  await pruneBestEffort(options);
  const read = await readStoredSession(manifestPath(resolvedRef, options.saptoolsRoot));
  if (!read.ok) {
    throw readFailureError(resolvedRef, read.failure, options.saptoolsRoot);
  }
  // Enforce the TTL here rather than trusting the prune above to have done it.
  // That prune is best-effort, so an expired session in a directory that cannot
  // be unlinked would otherwise still read back indefinitely.
  const now = (options.now?.() ?? new Date()).getTime();
  const expiry = resolveExpiryMillis(read.session);
  if (expiry === undefined) {
    // Readable rows, but no expiry this version can establish — the same
    // disposition prune gives it: reported, never served, never deleted.
    throw readFailureError(resolvedRef, "unrecognized", options.saptoolsRoot);
  }
  if (expiry <= now) {
    throw new CfHanaError("QUERY", "Saved result not found or expired");
  }
  return toSession(read.session, resolvedRef, options.saptoolsRoot);
}

/** List active saved results without loading their full decoded values. */
export async function listResultSessions(
  options: ResultStoreOptions = {},
): Promise<readonly ResultSessionSummary[]> {
  await pruneBestEffort(options);
  const refs = await listSessionRefs(options.saptoolsRoot);
  const now = (options.now?.() ?? new Date()).getTime();
  const reads = await Promise.all(
    refs.map(async (ref) => ({ ref, read: await readStoredSession(manifestPath(ref, options.saptoolsRoot)) })),
  );
  return reads
    .flatMap(({ ref, read }) => {
      if (!read.ok) {
        return [];
      }
      const expiry = resolveExpiryMillis(read.session);
      if (expiry === undefined || expiry <= now) {
        return [];
      }
      // The ref comes from the directory name, not the manifest body: only the
      // directory name is addressable by `result show`.
      return [
        {
          ref,
          createdAt: read.session.createdAt,
          expiresAt: read.session.expiresAt,
          rowCount: read.session.result.rowCount,
          columnCount: read.session.result.columns.length,
          truncated: read.session.result.truncated,
        },
      ];
    })
    .sort((left, right) => left.ref.localeCompare(right.ref));
}

/**
 * Remove expired saved result sessions.
 *
 * Only expired sessions and empty ref directories are removed. A manifest that
 * cannot be read or recognized is counted in `retained` and left exactly where
 * it is; deleting those was how a downgrade, a stale global install or a
 * momentary permission error silently destroyed a saved query result.
 */
export async function pruneResultSessions(options: ResultStoreOptions = {}): Promise<PruneOutcome> {
  const refs = await listSessionRefs(options.saptoolsRoot);
  const now = (options.now?.() ?? new Date()).getTime();
  let removed = 0;
  let failed = 0;
  const retainedRefs: string[] = [];
  for (const ref of refs) {
    const directory = sessionDirectory(ref, options.saptoolsRoot);
    const read = await readStoredSession(manifestPath(ref, options.saptoolsRoot));
    if (!read.ok && read.failure !== "absent") {
      retainedRefs.push(ref);
      continue;
    }
    if (read.ok) {
      const expiry = resolveExpiryMillis(read.session);
      if (expiry === undefined) {
        // Readable, but this version cannot establish an expiry: retain it like any other
        // manifest this version cannot fully interpret, rather than deleting
        // rows it can actually read.
        retainedRefs.push(ref);
        continue;
      }
      if (expiry > now) {
        continue;
      }
    }
    if (!read.ok && !(await isEmptyDirectory(directory))) {
      retainedRefs.push(ref);
      continue;
    }
    // Delete per session rather than letting one failure abort the sweep: a
    // single undeletable directory used to fail every save, read and list
    // outright, because all three prune first.
    try {
      await rm(directory, { recursive: true, force: true });
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed, retainedRefs };
}

/**
 * Housekeeping prune for the operations that are not *about* pruning. It
 * swallows its own failure on purpose: a results directory that cannot be
 * listed must not stop the user from saving, reading or listing a session that
 * is perfectly intact. `result prune` calls the throwing form and reports what
 * it found, so a broken store stays diagnosable on demand.
 */
async function pruneBestEffort(options: ResultStoreOptions): Promise<void> {
  try {
    await pruneResultSessions(options);
  } catch {
    // Intentionally ignored; see the doc comment.
  }
}

/** Remove every saved result session. */
export async function clearResultSessions(options: ResultStoreOptions = {}): Promise<number> {
  const refs = await listSessionRefs(options.saptoolsRoot);
  await Promise.all(
    refs.map(async (ref) => {
      await rm(sessionDirectory(ref, options.saptoolsRoot), { recursive: true, force: true });
    }),
  );
  return refs.length;
}
