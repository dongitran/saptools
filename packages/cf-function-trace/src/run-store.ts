import { randomBytes } from "node:crypto";
import { access, chmod, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { canonicalizeState } from "./canonical-state.js";
import type { JsonValue, StatePatch, TraceEventInput, TraceRunManifest } from "./contracts.js";
import { TraceDataError } from "./errors.js";
import { validateFunctionSelector, validateRunId, validateRuntimeFile } from "./validation.js";

const STORE_NAME = "cf-function-trace";
const DATA_DIRECTORY = "data";
const EVENTS_DIRECTORY = "events";
const STATES_DIRECTORY = "states";
const MANIFEST_NAME = "manifest.json";
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RUNS = 100;
const DEFAULT_MAX_RUN_BYTES = 64 * 1024 * 1024;

export interface TraceStoreOptions {
  readonly saptoolsRoot?: string;
  readonly runId?: string;
  readonly now?: () => Date;
  readonly retentionMs?: number;
  readonly maxRuns?: number;
  readonly maxRunBytes?: number;
}

export interface TraceRunInput {
  readonly sourceUrl: string;
  readonly sourceHash?: string;
  readonly functionSelector: string;
}

export interface TraceRun {
  readonly runId: string;
  readonly directory: string;
  readonly eventsDirectory: string;
  readonly statesDirectory: string;
  readonly manifestPath: string;
  readonly manifest: TraceRunManifest;
  readonly maxBytes: number;
}

export interface WrittenStateArtifact {
  readonly path: string;
  readonly hash: string;
  readonly state: JsonValue;
}

export function traceDataRoot(saptoolsRoot?: string): string {
  const root = saptoolsRoot ?? join(homedir(), ".saptools");
  return join(root, STORE_NAME, DATA_DIRECTORY);
}

function randomRunId(): string {
  return `t${randomBytes(8).toString("hex")}`;
}

function sequenceName(seq: number): string {
  if (!Number.isInteger(seq) || seq < 0 || seq > 999_999) {
    throw new TraceDataError("INVALID_ARGUMENT", "Trace sequence must be between 0 and 999999.");
  }
  return seq.toString().padStart(6, "0");
}

async function makePrivateDirectory(path: string, recursive: boolean): Promise<void> {
  await mkdir(path, { recursive, mode: 0o700 });
  await chmod(path, 0o700);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeSerializedJsonAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeSerializedJsonAtomic(path: string, serialized: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid.toString()}-${randomBytes(4).toString("hex")}`;
  let renamed = false;
  try {
    await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    renamed = true;
  } finally {
    if (!renamed) {
      await rm(temporaryPath, { force: true });
    }
  }
}

async function writeSerializedJsonExclusiveAtomic(path: string, serialized: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid.toString()}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    try {
      await link(temporaryPath, path);
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
        throw new TraceDataError("INVALID_ARTIFACT", "Trace artifact sequence already exists.");
      }
      throw error;
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function storedBytes(path: string): Promise<number> {
  try {
    const metadata = await stat(path);
    return metadata.isFile() ? metadata.size : 0;
  } catch {
    return 0;
  }
}

async function directoryBytes(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true });
  const sizes = await Promise.all(entries.map(async (entry): Promise<number> => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      return await directoryBytes(child);
    }
    return entry.isFile() ? await storedBytes(child) : 0;
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

async function writeRunJsonAtomic(
  run: TraceRun,
  path: string,
  value: unknown,
  exclusive = false,
): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const currentBytes = await directoryBytes(run.directory);
  const replacedBytes = exclusive ? 0 : await storedBytes(path);
  const projectedBytes = currentBytes - replacedBytes + Buffer.byteLength(serialized);
  if (projectedBytes > run.maxBytes) {
    throw new TraceDataError("RUN_STORAGE_LIMIT", `Trace run exceeds its ${run.maxBytes.toString()} byte storage limit.`);
  }
  await (exclusive
    ? writeSerializedJsonExclusiveAtomic(path, serialized)
    : writeSerializedJsonAtomic(path, serialized));
}

function createManifest(input: TraceRunInput, runId: string, now: Date, retentionMs: number): TraceRunManifest {
  if (input.sourceHash !== undefined && !/^[0-9a-f]{64}$/u.test(input.sourceHash)) {
    throw new TraceDataError("INVALID_ARGUMENT", "sourceHash must be a lowercase SHA-256 digest.");
  }
  return {
    version: 1,
    runId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + retentionMs).toISOString(),
    sourceUrl: validateRuntimeFile(input.sourceUrl),
    ...(input.sourceHash === undefined ? {} : { sourceHash: input.sourceHash }),
    functionSelector: validateFunctionSelector(input.functionSelector),
    status: "recording",
  };
}

interface TraceStoreLimits {
  readonly maxRuns: number;
  readonly retentionMs: number;
  readonly maxRunBytes: number;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TraceDataError("INVALID_ARGUMENT", `${name} must be a positive safe integer.`);
  }
  return value;
}

function traceStoreLimits(options: TraceStoreOptions): TraceStoreLimits {
  return {
    maxRuns: positiveSafeInteger(options.maxRuns ?? DEFAULT_MAX_RUNS, "maxRuns"),
    retentionMs: positiveSafeInteger(options.retentionMs ?? DEFAULT_RETENTION_MS, "retentionMs"),
    maxRunBytes: positiveSafeInteger(options.maxRunBytes ?? DEFAULT_MAX_RUN_BYTES, "maxRunBytes"),
  };
}

export async function createTraceRun(
  input: TraceRunInput,
  options: TraceStoreOptions = {},
): Promise<TraceRun> {
  const limits = traceStoreLimits(options);
  await pruneTraceRuns({ ...options, maxRuns: limits.maxRuns - 1 });
  const runId = validateRunId(options.runId ?? randomRunId());
  const now = options.now?.() ?? new Date();
  const manifest = createManifest(input, runId, now, limits.retentionMs);
  const dataRoot = traceDataRoot(options.saptoolsRoot);
  const directory = join(dataRoot, runId);
  const eventsDirectory = join(directory, EVENTS_DIRECTORY);
  const statesDirectory = join(directory, STATES_DIRECTORY);
  await makePrivateDirectory(dataRoot, true);
  await makePrivateDirectory(directory, false);
  await makePrivateDirectory(eventsDirectory, false);
  await makePrivateDirectory(statesDirectory, false);
  const manifestPath = join(directory, MANIFEST_NAME);
  await writeJsonAtomic(manifestPath, manifest);
  return { runId, directory, eventsDirectory, statesDirectory, manifestPath, manifest, maxBytes: limits.maxRunBytes };
}

export async function writeFullState(run: TraceRun, seq: number, value: unknown): Promise<WrittenStateArtifact> {
  const canonical = canonicalizeState(value);
  const path = join(run.statesDirectory, `${sequenceName(seq)}.full.json`);
  await writeRunJsonAtomic(run, path, {
    version: 1,
    kind: "full",
    seq,
    hash: canonical.hash,
    state: canonical.value,
  }, true);
  return { path, hash: canonical.hash, state: canonical.value };
}

export async function writePatchState(
  run: TraceRun,
  seq: number,
  parentSeq: number,
  patch: StatePatch,
): Promise<WrittenStateArtifact> {
  const path = join(run.statesDirectory, `${sequenceName(seq)}.patch.json`);
  await writeRunJsonAtomic(run, path, {
    version: 1,
    kind: "patch",
    seq,
    parentSeq,
    beforeHash: patch.before.hash,
    afterHash: patch.after.hash,
    operations: patch.operations,
  }, true);
  return { path, hash: patch.after.hash, state: patch.after.value };
}

export async function writeTraceEvent(run: TraceRun, event: TraceEventInput): Promise<string> {
  const path = join(run.eventsDirectory, `${sequenceName(event.seq)}.json`);
  await writeRunJsonAtomic(run, path, { version: 1, ...event }, true);
  return path;
}

export async function updateTraceRunStatus(
  run: TraceRun,
  status: TraceRunManifest["status"],
): Promise<void> {
  await writeRunJsonAtomic(run, run.manifestPath, { ...run.manifest, status });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function purgeTraceRun(runId: string, options: TraceStoreOptions = {}): Promise<boolean> {
  const validated = validateRunId(runId);
  const directory = join(traceDataRoot(options.saptoolsRoot), validated);
  if (!await pathExists(directory)) {
    return false;
  }
  await rm(directory, { recursive: true, force: true });
  return true;
}

async function storedRunMetadata(
  path: string,
  expectedRunId: string,
): Promise<{ readonly runId: string; readonly createdAt: number; readonly expiresAt: number } | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(path, MANIFEST_NAME), "utf8"));
    if (!isUnknownRecord(parsed)) {
      return undefined;
    }
    const runId = parsed["runId"];
    const createdAt = parsed["createdAt"];
    const expiresAt = parsed["expiresAt"];
    if (runId !== expectedRunId || typeof createdAt !== "string" || typeof expiresAt !== "string") {
      return undefined;
    }
    const createdAtMs = Date.parse(createdAt);
    const expiresAtMs = Date.parse(expiresAt);
    return Number.isFinite(createdAtMs) && Number.isFinite(expiresAtMs)
      ? { runId, createdAt: createdAtMs, expiresAt: expiresAtMs }
      : undefined;
  } catch {
    return undefined;
  }
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function pruneTraceRuns(options: TraceStoreOptions = {}): Promise<number> {
  const root = traceDataRoot(options.saptoolsRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  const metadata = (await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^t[0-9a-f]{16}$/u.test(entry.name))
    .map(async (entry) => await storedRunMetadata(join(root, entry.name), entry.name))))
    .filter((value): value is { readonly runId: string; readonly createdAt: number; readonly expiresAt: number } => value !== undefined)
    .sort((left, right) => right.createdAt - left.createdAt);
  const now = (options.now?.() ?? new Date()).getTime();
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 0) {
    throw new TraceDataError("INVALID_ARGUMENT", "maxRuns must be a non-negative safe integer.");
  }
  const removed = metadata.filter((run, index) => run.expiresAt <= now || index >= maxRuns);
  await Promise.all(removed.map(async ({ runId }) => {
    if (/^t[0-9a-f]{16}$/u.test(runId)) {
      await rm(join(root, runId), { recursive: true, force: true });
    }
  }));
  return removed.length;
}
