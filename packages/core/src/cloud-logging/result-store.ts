import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveSaptoolsRoot } from "../saptools-paths.js";

const RESULT_REF_PATTERN = /^[0-9a-f]{8}$/;
const TEMP_REF_PATTERN = /^([0-9a-f]{8})\.tmp-(\d+)$/;
const MANIFEST_FILE_NAME = "manifest.json";
const MAX_DATE_MILLIS = 8_640_000_000_000_000;
const DEFAULT_TTL_MINUTES = 10_080;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

interface StoredResultSession<TRow> {
  readonly version: 1;
  readonly ref: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly ttlMinutes: number;
  readonly command: string;
  readonly rows: readonly TRow[];
}

export interface CreateResultSessionInput<TRow> {
  readonly cliName: string;
  readonly command: string;
  readonly rows: readonly TRow[];
  readonly ttlMinutes?: number;
}

export interface ResultStoreOptions {
  readonly cliName: string;
  readonly saptoolsRoot?: string;
  readonly now?: () => Date;
  readonly ref?: string;
  readonly maxBytes?: number;
}

export type ResultSession<TRow> = StoredResultSession<TRow>;

export interface ResultSessionSummary {
  readonly ref: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly command: string;
  readonly rowCount: number;
}

export interface PruneOutcome {
  readonly removed: number;
  readonly failed: number;
  readonly retainedRefs: readonly string[];
  readonly strandedRemoved: number;
}

function resultsRoot(options: Pick<ResultStoreOptions, "cliName" | "saptoolsRoot">): string {
  return join(resolveSaptoolsRoot(options.saptoolsRoot), options.cliName, "results");
}

function sessionDirectory(ref: string, options: Pick<ResultStoreOptions, "cliName" | "saptoolsRoot">): string {
  return join(resultsRoot(options), ref);
}

function manifestPath(ref: string, options: Pick<ResultStoreOptions, "cliName" | "saptoolsRoot">): string {
  return join(sessionDirectory(ref, options), MANIFEST_FILE_NAME);
}

function resolveRef(value: string | undefined): string {
  const ref = value ?? randomBytes(4).toString("hex");
  if (!RESULT_REF_PATTERN.test(ref)) {
    throw new Error("Invalid saved result ref");
  }
  return ref;
}

function resolveTtl(value: number | undefined): number {
  const ttl = value ?? DEFAULT_TTL_MINUTES;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    throw new Error("Result TTL must be a positive safe integer");
  }
  return ttl;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredSession<TRow>(value: unknown): value is StoredResultSession<TRow> {
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

type SessionReadFailure = "absent" | "unreadable" | "unrecognized";
type SessionRead<TRow> = { readonly ok: true; readonly session: StoredResultSession<TRow> } | { readonly ok: false; readonly failure: SessionReadFailure };

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function readStoredSession<TRow>(path: string): Promise<SessionRead<TRow>> {
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
  if (isStoredSession<TRow>(parsed)) {
    return { ok: true, session: parsed };
  }
  return { ok: false, failure: "unrecognized" };
}

function resolveExpiryMillis(session: StoredResultSession<unknown>): number | undefined {
  const explicit = Date.parse(session.expiresAt);
  if (Number.isFinite(explicit)) {
    return explicit;
  }
  const created = Date.parse(session.createdAt);
  if (!Number.isFinite(created) || !Number.isSafeInteger(session.ttlMinutes) || session.ttlMinutes <= 0) {
    return undefined;
  }
  const derived = created + session.ttlMinutes * 60_000;
  if (Math.abs(derived) > MAX_DATE_MILLIS) {
    return undefined;
  }
  return derived;
}

async function listSessionRefs(options: ResultStoreOptions): Promise<readonly string[]> {
  try {
    const entries = await readdir(resultsRoot(options), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && RESULT_REF_PATTERN.test(entry.name)).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function isOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

const STRANDED_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Remove `<ref>.tmp-<pid>` directories left behind by an interrupted save.
 * Liveness (`process.kill(pid, 0)`) is the primary gate — real-world
 * measurement (see `.plans` design doc / project memory) found pid reuse
 * rare enough that 100/100 real saves survived a sweep with only the
 * liveness check. The 24h mtime age gate is a fallback for a pid namespace
 * where a live pid in a *different* container reads as dead (`ESRCH`).
 */
async function removeStrandedTempDirectories(options: ResultStoreOptions): Promise<number> {
  const root = resultsRoot(options);
  let names: readonly string[];
  try {
    names = await readdir(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const match = TEMP_REF_PATTERN.exec(name);
    if (match === null) {
      continue;
    }
    const pid = Number(match[2]);
    const path = join(root, name);
    let ageMs: number;
    try {
      ageMs = Date.now() - (await stat(path)).mtimeMs;
    } catch {
      continue;
    }
    if (isOwnerAlive(pid) && ageMs < STRANDED_AGE_MS) {
      continue;
    }
    try {
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // best effort
    }
  }
  return removed;
}

export async function createResultSession<TRow>(input: CreateResultSessionInput<TRow>, options: Omit<ResultStoreOptions, "cliName"> = {}): Promise<ResultSession<TRow>> {
  const fullOptions: ResultStoreOptions = { ...options, cliName: input.cliName };
  await pruneBestEffort(fullOptions);
  const ref = resolveRef(fullOptions.ref);
  const now = fullOptions.now?.() ?? new Date();
  const ttlMinutes = resolveTtl(input.ttlMinutes);
  const stored: StoredResultSession<TRow> = {
    version: 1,
    ref,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
    ttlMinutes,
    command: input.command,
    rows: input.rows,
  };
  const serialized = `${JSON.stringify(stored)}\n`;
  if (Buffer.byteLength(serialized) > (fullOptions.maxBytes ?? DEFAULT_MAX_BYTES)) {
    throw new Error("Saved result exceeds the storage limit");
  }
  const root = resultsRoot(fullOptions);
  const finalDirectory = sessionDirectory(ref, fullOptions);
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

/** Verify a saved result could be written, without writing one — call before expensive credential discovery so a broken store fails fast. */
export async function assertResultStoreWritable(options: ResultStoreOptions): Promise<void> {
  const root = resultsRoot(options);
  const probe = join(root, `.writable-${process.pid.toString()}-${randomBytes(4).toString("hex")}`);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(probe, "", { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`--save cannot write to the saved-result store at ${root}: ${message}`, { cause: error });
  }
  try {
    await unlink(probe);
  } catch {
    // already proved what it was for
  }
}

function readFailureError(ref: string, failure: SessionReadFailure, options: ResultStoreOptions): Error {
  const path = manifestPath(ref, options);
  switch (failure) {
    case "absent": {
      return new Error("Saved result not found or expired");
    }
    case "unreadable": {
      return new Error(`Saved result "${ref}" exists but could not be read; check permissions on ${path}`);
    }
    case "unrecognized": {
      return new Error(`Saved result "${ref}" is not in a format this version understands. It has been left in place at ${path}.`);
    }
  }
}

export async function readResultSession<TRow>(ref: string, options: ResultStoreOptions): Promise<ResultSession<TRow>> {
  const resolvedRef = resolveRef(ref);
  await pruneBestEffort(options);
  const read = await readStoredSession<TRow>(manifestPath(resolvedRef, options));
  if (!read.ok) {
    throw readFailureError(resolvedRef, read.failure, options);
  }
  const now = (options.now?.() ?? new Date()).getTime();
  const expiry = resolveExpiryMillis(read.session);
  if (expiry === undefined) {
    throw readFailureError(resolvedRef, "unrecognized", options);
  }
  if (expiry <= now) {
    throw new Error("Saved result not found or expired");
  }
  return read.session;
}

export async function listResultSessions(options: ResultStoreOptions): Promise<readonly ResultSessionSummary[]> {
  await pruneBestEffort(options);
  const refs = await listSessionRefs(options);
  const now = (options.now?.() ?? new Date()).getTime();
  const reads = await Promise.all(refs.map(async (ref) => ({ ref, read: await readStoredSession(manifestPath(ref, options)) })));
  return reads
    .flatMap(({ ref, read }) => {
      if (!read.ok) {
        return [];
      }
      const expiry = resolveExpiryMillis(read.session);
      if (expiry === undefined || expiry <= now) {
        return [];
      }
      return [{ ref, createdAt: read.session.createdAt, expiresAt: read.session.expiresAt, command: read.session.command, rowCount: read.session.rows.length }];
    })
    .sort((left, right) => left.ref.localeCompare(right.ref));
}

async function isEmptyDirectory(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch {
    return false;
  }
}

export async function pruneResultSessions(options: ResultStoreOptions): Promise<PruneOutcome> {
  const refs = await listSessionRefs(options);
  const now = (options.now?.() ?? new Date()).getTime();
  let removed = 0;
  let failed = 0;
  const retainedRefs: string[] = [];
  for (const ref of refs) {
    const directory = sessionDirectory(ref, options);
    const read = await readStoredSession(manifestPath(ref, options));
    if (!read.ok && read.failure !== "absent") {
      retainedRefs.push(ref);
      continue;
    }
    if (read.ok) {
      const expiry = resolveExpiryMillis(read.session);
      if (expiry === undefined) {
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
    try {
      await rm(directory, { recursive: true, force: true });
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  const strandedRemoved = await removeStrandedTempDirectories(options);
  return { removed, failed, retainedRefs, strandedRemoved };
}

async function pruneBestEffort(options: ResultStoreOptions): Promise<void> {
  try {
    await pruneResultSessions(options);
  } catch {
    // Intentionally ignored: a broken store must not block save/read/list of an intact session.
  }
}

export async function clearResultSessions(options: ResultStoreOptions): Promise<number> {
  const refs = await listSessionRefs(options);
  await Promise.all(refs.map(async (ref) => { await rm(sessionDirectory(ref, options), { recursive: true, force: true }); }));
  return refs.length;
}
