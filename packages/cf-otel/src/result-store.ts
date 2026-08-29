import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_RESULT_TTL_MINUTES, MAX_RESULT_STORE_BYTES } from "./config.js";
import { CfOtelError } from "./errors.js";
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

async function readStoredSession(path: string): Promise<StoredResultSession | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isStoredSession(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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

/** Save one command's rows for later inspection and return its temporary ref. */
export async function createResultSession(
  input: CreateResultSessionInput,
  options: ResultStoreOptions = {},
): Promise<ResultSession> {
  await pruneResultSessions(options);
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

/** Attempt an advisory result save without turning a successful command into a failure. */
export async function tryCreateResultSession(
  input: CreateResultSessionInput,
  options: ResultStoreOptions = {},
): Promise<ResultSession | undefined> {
  try {
    return await createResultSession(input, options);
  } catch {
    return undefined;
  }
}

/** Read one active saved result by ref. */
export async function readResultSession(ref: string, options: ResultStoreOptions = {}): Promise<ResultSession> {
  const resolvedRef = resolveRef(ref);
  await pruneResultSessions(options);
  const stored = await readStoredSession(manifestPath(resolvedRef, options.saptoolsRoot));
  if (stored === undefined) {
    throw new CfOtelError("RESULT_NOT_FOUND", "Saved result not found or expired");
  }
  return stored;
}

/** List active saved results without loading their full row data. */
export async function listResultSessions(options: ResultStoreOptions = {}): Promise<readonly ResultSessionSummary[]> {
  await pruneResultSessions(options);
  const refs = await listSessionRefs(options.saptoolsRoot);
  const stored = await Promise.all(refs.map(async (ref) => await readStoredSession(manifestPath(ref, options.saptoolsRoot))));
  return stored
    .filter((item): item is StoredResultSession => item !== undefined)
    .map((item) => ({ ref: item.ref, createdAt: item.createdAt, expiresAt: item.expiresAt, command: item.command, rowCount: item.rows.length }))
    .sort((left, right) => left.ref.localeCompare(right.ref));
}

/** Remove expired or malformed saved result sessions. */
export async function pruneResultSessions(options: ResultStoreOptions = {}): Promise<number> {
  const refs = await listSessionRefs(options.saptoolsRoot);
  const now = (options.now?.() ?? new Date()).getTime();
  let removed = 0;
  for (const ref of refs) {
    const stored = await readStoredSession(manifestPath(ref, options.saptoolsRoot));
    if (stored === undefined || Date.parse(stored.expiresAt) <= now) {
      await rm(sessionDirectory(ref, options.saptoolsRoot), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

/** Remove every saved result session. */
export async function clearResultSessions(options: ResultStoreOptions = {}): Promise<number> {
  const refs = await listSessionRefs(options.saptoolsRoot);
  await Promise.all(refs.map(async (ref) => { await rm(sessionDirectory(ref, options.saptoolsRoot), { recursive: true, force: true }); }));
  return refs.length;
}
