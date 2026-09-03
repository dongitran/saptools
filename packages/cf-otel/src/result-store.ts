import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_RESULT_TTL_MINUTES, MAX_RESULT_STORE_BYTES } from "./config.js";
import { CfOtelError, errorMessage } from "./errors.js";
import type { OutputRow } from "./format.js";

const RESULT_REF_PATTERN = /^[0-9a-f]{8}$/;
const MANIFEST_FILE_NAME = "manifest.json";

interface StoredResultSession {
  readonly version: 1;
  readonly ref: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly ttlMinutes: number;
  readonly command: string;
  readonly rows: readonly OutputRow[];
}

export interface CreateResultSessionInput {
  readonly command: string;
  readonly rows: readonly OutputRow[];
  readonly ttlMinutes?: number;
}

export interface ResultStoreOptions {
  readonly saptoolsRoot?: string;
  readonly now?: () => Date;
  readonly ref?: string;
  readonly maxBytes?: number;
}

export type ResultSession = StoredResultSession;

export interface ResultSessionSummary {
  readonly ref: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly command: string;
  readonly rowCount: number;
}

/**
 * What one prune sweep did. `retained` counts sessions deliberately left
 * behind because their manifest could not be read or recognized, and `failed`
 * counts expired sessions that could not be deleted — both are silent by
 * design everywhere except `result prune`, which is the command whose job is
 * to report on the store.
 */
export interface PruneOutcome {
  readonly removed: number;
  readonly retained: number;
  readonly failed: number;
}

function resultsRoot(saptoolsRoot?: string): string {
  return join(saptoolsRoot ?? join(homedir(), ".saptools"), "cf-otel", "results");
}

/** Read an optional results-root override from the environment (mirrors CF_OTEL_CF_BIN's test-only override hook — lets e2e tests avoid touching the real ~/.saptools directory). Unset in normal usage. */
export function resultStoreOptionsFromEnv(): ResultStoreOptions {
  const saptoolsRoot = process.env["CF_OTEL_RESULTS_ROOT"];
  return saptoolsRoot === undefined || saptoolsRoot.length === 0 ? {} : { saptoolsRoot };
}

function sessionDirectory(ref: string, saptoolsRoot?: string): string {
  return join(resultsRoot(saptoolsRoot), ref);
}

function manifestPath(ref: string, saptoolsRoot?: string): string {
  return join(sessionDirectory(ref, saptoolsRoot), MANIFEST_FILE_NAME);
}

function resolveRef(value: string | undefined): string {
  const ref = value ?? randomBytes(4).toString("hex");
  if (!RESULT_REF_PATTERN.test(ref)) {
    throw new CfOtelError("CONFIG", "Invalid saved result ref");
  }
  return ref;
}

function resolveTtl(value: number | undefined): number {
  const ttl = value ?? DEFAULT_RESULT_TTL_MINUTES;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    throw new CfOtelError("CONFIG", "Result TTL must be a positive safe integer");
  }
  return ttl;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shape check only — deliberately not a validity check. A manifest whose
 * `expiresAt` is a string but not a real instant still passes here, because
 * expiry is resolved separately (see `resolveExpiryMillis`); rejecting it as
 * unrecognized instead would move it onto the retain path, where no TTL could
 * ever reap it — the leak this whole module is trying to close.
 */
function isStoredSession(value: unknown): value is StoredResultSession {
  return (
    isRecord(value) &&
    value["version"] === 1 &&
    typeof value["ref"] === "string" &&
    typeof value["createdAt"] === "string" &&
    typeof value["expiresAt"] === "string" &&
    typeof value["ttlMinutes"] === "number" &&
    typeof value["command"] === "string" &&
    Array.isArray(value["rows"])
  );
}

/**
 * Why a stored session could not be returned. The distinction is load-bearing:
 * prune may delete on `absent`, but must never delete on `unreadable` (a
 * transient EACCES or EIO leaves the data itself intact) or on `unrecognized`
 * (a manifest written by a newer cf-otel, or a partial write worth keeping for
 * inspection). Collapsing all three into one "missing" answer is what used to
 * make a nominally read-only `result list` destroy user data.
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
 * The instant a session stops being readable, in epoch millis.
 *
 * `createResultSession` always writes a valid `expiresAt`, so an unparseable
 * one means the manifest was damaged after it was written; `createdAt` plus
 * `ttlMinutes` is tried next. When neither is usable the session is reported
 * as already expired, and that is deliberate: the TTL is a retention promise
 * over production span data, so a record whose age cannot be established must
 * not be kept forever. Previously such a manifest was immortal, because
 * `Date.parse` returns `NaN` and `NaN <= now` is false.
 */
function resolveExpiryMillis(session: StoredResultSession): number {
  const explicit = Date.parse(session.expiresAt);
  if (Number.isFinite(explicit)) {
    return explicit;
  }
  const created = Date.parse(session.createdAt);
  if (Number.isFinite(created) && Number.isFinite(session.ttlMinutes)) {
    return created + session.ttlMinutes * 60_000;
  }
  return Number.NEGATIVE_INFINITY;
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

/**
 * A ref directory with no manifest at all is either a crashed save or a layout
 * this version does not know. An empty one is safe to reclaim; one holding
 * other files is retained, so that a manifest stored under a different name —
 * by a future release, or by a newer binary on the same machine — can never be
 * mistaken for garbage and deleted.
 */
async function isEmptyDirectory(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch {
    return false;
  }
}

/** Save one command's rows for later inspection and return its temporary ref. */
export async function createResultSession(
  input: CreateResultSessionInput,
  options: ResultStoreOptions = {},
): Promise<ResultSession> {
  await pruneBestEffort(options);
  const ref = resolveRef(options.ref);
  const now = options.now?.() ?? new Date();
  const ttlMinutes = resolveTtl(input.ttlMinutes);
  const stored: StoredResultSession = {
    version: 1,
    ref,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
    ttlMinutes,
    command: input.command,
    rows: input.rows,
  };
  const serialized = `${JSON.stringify(stored)}\n`;
  if (Buffer.byteLength(serialized) > (options.maxBytes ?? MAX_RESULT_STORE_BYTES)) {
    throw new CfOtelError("CONFIG", "Saved result exceeds the storage limit");
  }

  const root = resultsRoot(options.saptoolsRoot);
  const finalDirectory = sessionDirectory(ref, options.saptoolsRoot);
  const tempDirectory = `${finalDirectory}.tmp-${process.pid.toString()}`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await rm(tempDirectory, { recursive: true, force: true });
  await mkdir(tempDirectory, { mode: 0o700 });
  try {
    await writeFile(join(tempDirectory, MANIFEST_FILE_NAME), serialized, { encoding: "utf8", mode: 0o600 });
    await rename(tempDirectory, finalDirectory);
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
  return stored;
}

/**
 * Verify a saved result could be written, without writing one.
 *
 * Commands call this while validating arguments, before the CF login and
 * credential discovery that cost tens of seconds against a real tenant: an
 * store that cannot be written fails identically before and after that work, so paying for
 * it first only wastes the user's time. The check is a real create-and-unlink
 * rather than a permissions calculation, because ownership, ACLs, read-only
 * mounts and a plain file sitting where the results directory belongs all
 * surface only when something is actually written.
 */
export async function assertResultStoreWritable(options: ResultStoreOptions = {}): Promise<void> {
  const root = resultsRoot(options.saptoolsRoot);
  const probe = join(root, `.writable-${process.pid.toString()}-${randomBytes(4).toString("hex")}`);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(probe, "", { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    throw new CfOtelError(
      "RESULT_STORE_NOT_WRITABLE",
      `--save cannot write to the saved-result store at ${root}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  try {
    await unlink(probe);
  } catch {
    // The probe has already proven what it was for; failing to remove it is
    // not a reason to fail the command.
  }
}

function readFailureError(ref: string, failure: SessionReadFailure, saptoolsRoot?: string): CfOtelError {
  const path = manifestPath(ref, saptoolsRoot);
  switch (failure) {
    case "absent":
      return new CfOtelError("RESULT_NOT_FOUND", "Saved result not found or expired");
    case "unreadable":
      return new CfOtelError(
        "RESULT_UNREADABLE",
        `Saved result "${ref}" exists but could not be read; check permissions on ${path}`,
      );
    case "unrecognized":
      return new CfOtelError(
        "RESULT_UNREADABLE",
        `Saved result "${ref}" is not in a format this version of cf-otel understands. ` +
          `It has been left in place at ${path} — a newer cf-otel may be able to read it.`,
      );
  }
}

/** Read one active saved result by ref. */
export async function readResultSession(ref: string, options: ResultStoreOptions = {}): Promise<ResultSession> {
  const resolvedRef = resolveRef(ref);
  await pruneBestEffort(options);
  const read = await readStoredSession(manifestPath(resolvedRef, options.saptoolsRoot));
  if (!read.ok) {
    throw readFailureError(resolvedRef, read.failure, options.saptoolsRoot);
  }
  // Enforce the TTL here rather than trusting the prune above to have done it.
  // That prune is best-effort, so an expired session in a directory that
  // cannot be unlinked would otherwise still read back indefinitely.
  const now = (options.now?.() ?? new Date()).getTime();
  if (resolveExpiryMillis(read.session) <= now) {
    throw new CfOtelError("RESULT_NOT_FOUND", "Saved result not found or expired");
  }
  return read.session;
}

/** List active saved results without loading their full row data. */
export async function listResultSessions(options: ResultStoreOptions = {}): Promise<readonly ResultSessionSummary[]> {
  await pruneBestEffort(options);
  const refs = await listSessionRefs(options.saptoolsRoot);
  const now = (options.now?.() ?? new Date()).getTime();
  const reads = await Promise.all(
    refs.map(async (ref) => ({ ref, read: await readStoredSession(manifestPath(ref, options.saptoolsRoot)) })),
  );
  return reads
    .flatMap(({ ref, read }) => {
      if (!read.ok || resolveExpiryMillis(read.session) <= now) {
        return [];
      }
      // The ref comes from the directory name, not from the manifest body:
      // those can disagree, and only the directory name is addressable, so
      // printing the body's copy advertised a ref that `result show` rejected.
      return [
        {
          ref,
          createdAt: read.session.createdAt,
          expiresAt: read.session.expiresAt,
          command: read.session.command,
          rowCount: read.session.rows.length,
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
 * momentary permission error silently destroyed saved results.
 */
export async function pruneResultSessions(options: ResultStoreOptions = {}): Promise<PruneOutcome> {
  const refs = await listSessionRefs(options.saptoolsRoot);
  const now = (options.now?.() ?? new Date()).getTime();
  let removed = 0;
  let retained = 0;
  let failed = 0;
  for (const ref of refs) {
    const directory = sessionDirectory(ref, options.saptoolsRoot);
    const read = await readStoredSession(manifestPath(ref, options.saptoolsRoot));
    if (!read.ok && read.failure !== "absent") {
      retained += 1;
      continue;
    }
    if (read.ok && resolveExpiryMillis(read.session) > now) {
      continue;
    }
    if (!read.ok && !(await isEmptyDirectory(directory))) {
      retained += 1;
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
  return { removed, retained, failed };
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
  await Promise.all(refs.map(async (ref) => { await rm(sessionDirectory(ref, options.saptoolsRoot), { recursive: true, force: true }); }));
  return refs.length;
}
