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

async function readStoredSession(path: string): Promise<StoredResultSession | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isStoredSession(parsed) ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
}

function toSession(stored: StoredResultSession, saptoolsRoot?: string): ResultSession {
  return {
    ...stored,
    result: decodeResult(stored.result),
    directory: sessionDirectory(stored.ref, saptoolsRoot),
    path: manifestPath(stored.ref, saptoolsRoot),
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
  await pruneResultSessions(options);
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
  return toSession(stored, options.saptoolsRoot);
}

/** Read one active saved result by ref. */
export async function readResultSession(
  ref: string,
  options: ResultStoreOptions = {},
): Promise<ResultSession> {
  const resolvedRef = resolveRef(ref);
  await pruneResultSessions(options);
  const stored = await readStoredSession(manifestPath(resolvedRef, options.saptoolsRoot));
  if (stored === undefined) {
    throw new CfHanaError("QUERY", "Saved result not found or expired");
  }
  return toSession(stored, options.saptoolsRoot);
}

/** List active saved results without loading their full decoded values. */
export async function listResultSessions(
  options: ResultStoreOptions = {},
): Promise<readonly ResultSessionSummary[]> {
  await pruneResultSessions(options);
  const refs = await listSessionRefs(options.saptoolsRoot);
  const stored = await Promise.all(
    refs.map(async (ref) => await readStoredSession(manifestPath(ref, options.saptoolsRoot))),
  );
  return stored
    .filter((item): item is StoredResultSession => item !== undefined)
    .map((item) => ({
      ref: item.ref,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      rowCount: item.result.rowCount,
      columnCount: item.result.columns.length,
      truncated: item.result.truncated,
    }))
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
  await Promise.all(
    refs.map(async (ref) => {
      await rm(sessionDirectory(ref, options.saptoolsRoot), { recursive: true, force: true });
    }),
  );
  return refs.length;
}
