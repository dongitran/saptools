import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { canonicalizeState } from "./canonical-state.js";
import type {
  JsonValue,
  StatePatchOperation,
  TraceRunManifest,
} from "./contracts.js";
import { TraceDataError, type TraceDataErrorCode } from "./errors.js";
import { traceDataRoot, type TraceStoreOptions } from "./run-store.js";
import { applyStatePatch } from "./state-diff.js";
import { validateRunId } from "./validation.js";

export interface TraceRunSummary {
  readonly runId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly sourceUrl: string;
  readonly sourceHash?: string;
  readonly functionSelector: string;
  readonly status: TraceRunManifest["status"];
}

export interface StoredTraceEvent {
  readonly version: 1;
  readonly seq: number;
  readonly kind: "baseline" | "pause" | "completed" | "exception" | "truncated";
  readonly stateHash: string;
  readonly artifactKind: "full" | "patch" | "unchanged";
  readonly changedPaths: readonly string[];
  readonly functionName?: string;
  readonly depth?: number;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
}

type StateArtifact = FullStateArtifact | PatchStateArtifact;

interface FullStateArtifact {
  readonly kind: "full";
  readonly seq: number;
  readonly hash: string;
  readonly state: JsonValue;
}

interface PatchStateArtifact {
  readonly kind: "patch";
  readonly seq: number;
  readonly parentSeq: number;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly operations: readonly StatePatchOperation[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}

// `notFoundCode` lets ONLY the manifest lookup (a run that simply does not
// exist) map a missing file to a clean, expected code; event/state-artifact
// reads for an existing, valid run must keep reporting a missing file as the
// data-corruption signal (INVALID_ARTIFACT) it actually is, so the mapping
// is opt-in per call site rather than blanket-applied to every read.
async function readJson(path: string, notFoundCode?: TraceDataErrorCode): Promise<unknown> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed;
  } catch (error) {
    if (notFoundCode !== undefined && isEnoent(error)) {
      throw new TraceDataError(notFoundCode, "No trace run exists with that ID.");
    }
    throw new TraceDataError("INVALID_ARTIFACT", `Trace artifact could not be read: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function isRunStatus(value: unknown): value is TraceRunManifest["status"] {
  return typeof value === "string" && ["recording", "completed", "partial", "failed", "cancelled"].includes(value);
}

function invalidManifest(message = "Trace run manifest has invalid fields."): never {
  throw new TraceDataError("INVALID_ARTIFACT", message);
}

function manifestString(value: Readonly<Record<string, unknown>>, field: string): string {
  const candidate = value[field];
  return typeof candidate === "string" ? candidate : invalidManifest();
}

function manifestSourceHash(value: Readonly<Record<string, unknown>>): string | undefined {
  const sourceHash = value["sourceHash"];
  if (sourceHash === undefined) {
    return undefined;
  }
  return typeof sourceHash === "string" && /^[0-9a-f]{64}$/u.test(sourceHash)
    ? sourceHash
    : invalidManifest("Trace run manifest has an invalid source hash.");
}

function parseManifest(value: unknown): TraceRunManifest {
  if (!isRecord(value)) {
    return invalidManifest("Trace run manifest is not an object.");
  }
  if (value["version"] !== 1) {
    return invalidManifest();
  }
  const runId = manifestString(value, "runId");
  const createdAt = manifestString(value, "createdAt");
  const expiresAt = manifestString(value, "expiresAt");
  const sourceUrl = manifestString(value, "sourceUrl");
  const sourceHash = manifestSourceHash(value);
  const functionSelector = manifestString(value, "functionSelector");
  const status = value["status"];
  if (!isRunStatus(status)) {
    return invalidManifest();
  }
  validateRunId(runId);
  return {
    version: 1,
    runId,
    createdAt,
    expiresAt,
    sourceUrl,
    ...(sourceHash === undefined ? {} : { sourceHash }),
    functionSelector,
    status,
  };
}

export async function readTraceManifest(runId: string, options: TraceStoreOptions = {}): Promise<TraceRunManifest> {
  const validated = validateRunId(runId);
  const manifestPath = join(traceDataRoot(options.saptoolsRoot), validated, "manifest.json");
  const manifest = parseManifest(await readJson(manifestPath, "RUN_NOT_FOUND"));
  if (manifest.runId !== validated) {
    throw new TraceDataError("INVALID_ARTIFACT", "Trace manifest run ID does not match its directory.");
  }
  return manifest;
}

function toSummary(manifest: TraceRunManifest): TraceRunSummary {
  return {
    runId: manifest.runId,
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt,
    sourceUrl: manifest.sourceUrl,
    ...(manifest.sourceHash === undefined ? {} : { sourceHash: manifest.sourceHash }),
    functionSelector: manifest.functionSelector,
    status: manifest.status,
  };
}

export async function listTraceRuns(options: TraceStoreOptions = {}): Promise<readonly TraceRunSummary[]> {
  const root = traceDataRoot(options.saptoolsRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const manifests = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^t[0-9a-f]{16}$/u.test(entry.name))
    .map(async (entry) => {
      try {
        return await readTraceManifest(entry.name, options);
      } catch {
        return;
      }
    }));
  return manifests
    .filter((manifest): manifest is TraceRunManifest => manifest !== undefined)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(toSummary);
}

export async function resolveTraceRun(selector: string, options: TraceStoreOptions = {}): Promise<TraceRunSummary> {
  if (selector === "latest") {
    const latest = (await listTraceRuns(options))[0];
    if (latest === undefined) {
      throw new TraceDataError("RUN_NOT_FOUND", "No trace runs are available.");
    }
    return latest;
  }
  const manifest = await readTraceManifest(validateRunId(selector), options);
  return toSummary(manifest);
}

function isEventKind(value: unknown): value is StoredTraceEvent["kind"] {
  return typeof value === "string" && ["baseline", "pause", "completed", "exception", "truncated"].includes(value);
}

function isArtifactKind(value: unknown): value is StoredTraceEvent["artifactKind"] {
  return value === "full" || value === "patch" || value === "unchanged";
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function invalidTraceEvent(): never {
  throw new TraceDataError("INVALID_ARTIFACT", "Trace event has invalid fields.");
}

function parseEventSequence(value: Readonly<Record<string, unknown>>): number {
  const sequence = value["seq"];
  if (value["version"] !== 1 || typeof sequence !== "number" || !Number.isInteger(sequence)) {
    return invalidTraceEvent();
  }
  return sequence;
}

function parseEventKinds(value: Readonly<Record<string, unknown>>): Pick<StoredTraceEvent, "kind" | "artifactKind"> {
  const kind = value["kind"];
  const artifactKind = value["artifactKind"];
  if (!isEventKind(kind) || !isArtifactKind(artifactKind)) {
    return invalidTraceEvent();
  }
  return { kind, artifactKind };
}

function parseEventState(value: Readonly<Record<string, unknown>>): Pick<StoredTraceEvent, "stateHash" | "changedPaths"> {
  const stateHash = value["stateHash"];
  const changedPaths = value["changedPaths"];
  if (typeof stateHash !== "string" || !Array.isArray(changedPaths)) {
    return invalidTraceEvent();
  }
  if (!changedPaths.every((path): path is string => typeof path === "string")) {
    return invalidTraceEvent();
  }
  return { stateHash, changedPaths };
}

interface OptionalEventFields {
  functionName?: string;
  depth?: number;
  lineNumber?: number;
  columnNumber?: number;
}

function optionalEventFields(value: Readonly<Record<string, unknown>>): OptionalEventFields {
  const fields: OptionalEventFields = {};
  if (typeof value["functionName"] === "string") {
    fields.functionName = value["functionName"];
  }
  const numericFields = ["depth", "lineNumber", "columnNumber"] as const;
  for (const field of numericFields) {
    const parsed = optionalNumber(value[field]);
    if (parsed !== undefined) {
      fields[field] = parsed;
    }
  }
  return fields;
}

function parseTraceEvent(value: unknown): StoredTraceEvent {
  if (!isRecord(value)) {
    return invalidTraceEvent();
  }
  return {
    version: 1,
    seq: parseEventSequence(value),
    ...parseEventKinds(value),
    ...parseEventState(value),
    ...optionalEventFields(value),
  };
}

export async function readTraceEvents(
  runId: string,
  options: TraceStoreOptions = {},
): Promise<readonly StoredTraceEvent[]> {
  const directory = join(traceDataRoot(options.saptoolsRoot), validateRunId(runId), "events");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const paths = entries
    .filter((entry) => entry.isFile() && /^\d{6}\.json$/u.test(entry.name))
    .map((entry) => ({
      path: join(directory, entry.name),
      expectedSeq: Number.parseInt(entry.name.slice(0, 6), 10),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return await Promise.all(paths.map(async ({ path, expectedSeq }) => {
    const event = parseTraceEvent(await readJson(path));
    if (event.seq !== expectedSeq) {
      throw new TraceDataError("INVALID_ARTIFACT", "Trace event sequence does not match its file name.");
    }
    return event;
  }));
}

function parseOperation(value: unknown): StatePatchOperation | undefined {
  if (!isRecord(value) || typeof value["op"] !== "string" || typeof value["path"] !== "string") {
    return undefined;
  }
  if (value["op"] === "remove") {
    return { op: "remove", path: value["path"] };
  }
  const operationValue = value["value"];
  return (value["op"] === "add" || value["op"] === "replace") && isJsonValue(operationValue)
    ? { op: value["op"], path: value["path"], value: operationValue }
    : undefined;
}

function parseFullArtifact(value: Readonly<Record<string, unknown>>): FullStateArtifact | undefined {
  const seq = value["seq"];
  const hash = value["hash"];
  const state = value["state"];
  return value["kind"] === "full" && Number.isInteger(seq) && typeof seq === "number" &&
    typeof hash === "string" && isJsonValue(state)
    ? { kind: "full", seq, hash, state }
    : undefined;
}

function parsePatchArtifact(value: Readonly<Record<string, unknown>>): PatchStateArtifact | undefined {
  const seq = value["seq"];
  const parentSeq = value["parentSeq"];
  const beforeHash = value["beforeHash"];
  const afterHash = value["afterHash"];
  const rawOperations = value["operations"];
  if (value["kind"] !== "patch" || typeof seq !== "number" || !Number.isInteger(seq) ||
      typeof parentSeq !== "number" || !Number.isInteger(parentSeq) || typeof beforeHash !== "string" ||
      typeof afterHash !== "string" || !Array.isArray(rawOperations)) {
    return undefined;
  }
  const operations = rawOperations.map(parseOperation);
  return operations.every((operation): operation is StatePatchOperation => operation !== undefined)
    ? { kind: "patch", seq, parentSeq, beforeHash, afterHash, operations }
    : undefined;
}

async function readStateArtifact(path: string, expectedSeq: number): Promise<StateArtifact> {
  const parsed = await readJson(path);
  if (!isRecord(parsed) || parsed["version"] !== 1) {
    throw new TraceDataError("INVALID_ARTIFACT", "State artifact has an invalid version.");
  }
  const artifact = parseFullArtifact(parsed) ?? parsePatchArtifact(parsed);
  if (artifact === undefined) {
    throw new TraceDataError("INVALID_ARTIFACT", "State artifact has invalid fields.");
  }
  if (artifact.seq !== expectedSeq) {
    throw new TraceDataError("INVALID_ARTIFACT", "State artifact sequence does not match its file name.");
  }
  return artifact;
}

interface StateArtifactPath {
  readonly path: string;
  readonly expectedSeq: number;
}

interface ReplayedState {
  readonly state: JsonValue;
  readonly seq: number;
}

async function stateArtifactPaths(
  runId: string,
  seq: number,
  options: TraceStoreOptions,
): Promise<readonly StateArtifactPath[]> {
  const directory = join(traceDataRoot(options.saptoolsRoot), validateRunId(runId), "states");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new TraceDataError("STATE_NOT_FOUND", "Trace state directory was not found.");
  }
  return entries
    .filter((entry) => entry.isFile() && /^(\d{6})\.(?:full|patch)\.json$/u.test(entry.name))
    .filter((entry) => Number.parseInt(entry.name.slice(0, 6), 10) <= seq)
    .map((entry) => ({
      path: join(directory, entry.name),
      expectedSeq: Number.parseInt(entry.name.slice(0, 6), 10),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function verifyHash(state: JsonValue, expected: string): void {
  if (canonicalizeState(state).hash !== expected) {
    throw new TraceDataError("STATE_HASH_MISMATCH", "Trace state hash verification failed.");
  }
}

function replayArtifact(
  current: ReplayedState | undefined,
  artifact: StateArtifact,
): ReplayedState {
  if (artifact.kind === "full") {
    verifyHash(artifact.state, artifact.hash);
    return { state: artifact.state, seq: artifact.seq };
  }
  if (current?.seq !== artifact.parentSeq) {
    throw new TraceDataError("INVALID_ARTIFACT", "Patch parent sequence does not match replay state.");
  }
  verifyHash(current.state, artifact.beforeHash);
  const state = applyStatePatch(current.state, artifact.operations);
  verifyHash(state, artifact.afterHash);
  return { state, seq: artifact.seq };
}

function assertRequestedSequence(seq: number): void {
  if (!Number.isSafeInteger(seq) || seq < 0 || seq > 999_999) {
    throw new TraceDataError("INVALID_ARGUMENT", "Trace sequence must be between 0 and 999999.");
  }
}

function artifactKindAt(artifacts: readonly StateArtifact[], seq: number): StateArtifact["kind"] | undefined {
  const matching = artifacts.filter((artifact) => artifact.seq === seq);
  if (matching.length > 1) {
    throw new TraceDataError("INVALID_ARTIFACT", "A trace event has multiple state artifacts.");
  }
  return matching[0]?.kind;
}

function validateTimelineArtifacts(
  events: readonly StoredTraceEvent[],
  artifacts: readonly StateArtifact[],
): void {
  const eventsBySequence = new Map(events.map((event) => [event.seq, event]));
  for (const artifact of artifacts) {
    const event = eventsBySequence.get(artifact.seq);
    if (event?.artifactKind !== artifact.kind) {
      throw new TraceDataError("INVALID_ARTIFACT", "State artifact does not match its trace event.");
    }
  }
  for (const event of events) {
    const kind = artifactKindAt(artifacts, event.seq);
    const expected = event.artifactKind === "unchanged" ? undefined : event.artifactKind;
    if (kind !== expected) {
      throw new TraceDataError("INVALID_ARTIFACT", "Trace event does not match its state artifact.");
    }
  }
}

export async function readStateAt(runId: string, seq: number, options: TraceStoreOptions = {}): Promise<JsonValue> {
  assertRequestedSequence(seq);
  const events = (await readTraceEvents(runId, options)).filter((event) => event.seq <= seq);
  const targetEvent = events.find((event) => event.seq === seq);
  if (targetEvent === undefined) {
    throw new TraceDataError("STATE_NOT_FOUND", `No trace event exists at sequence ${String(seq)}.`);
  }
  const paths = await stateArtifactPaths(runId, seq, options);
  const artifacts = await Promise.all(paths.map(async ({ path, expectedSeq }) =>
    await readStateArtifact(path, expectedSeq)));
  validateTimelineArtifacts(events, artifacts);
  let current: ReplayedState | undefined;
  for (const artifact of artifacts) {
    current = replayArtifact(current, artifact);
  }
  if (current === undefined) {
    throw new TraceDataError("INVALID_ARTIFACT", `Trace event ${String(seq)} has no replayable state.`);
  }
  verifyHash(current.state, targetEvent.stateHash);
  return current.state;
}

function decodePointer(path: string): readonly string[] {
  if (path === "") {
    return [];
  }
  if (!path.startsWith("/")) {
    throw new TraceDataError("INVALID_ARGUMENT", "State path must be a JSON Pointer.");
  }
  return path.slice(1).split("/").map((segment) => {
    if (/~(?:[^01]|$)/u.test(segment)) {
      throw new TraceDataError("INVALID_ARGUMENT", "State path contains an invalid JSON Pointer escape.");
    }
    return segment.replaceAll("~1", "/").replaceAll("~0", "~");
  });
}

function childAt(value: JsonValue, segment: string): JsonValue | undefined {
  if (["__proto__", "constructor", "prototype"].includes(segment)) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const index = Number.parseInt(segment, 10);
    return Number.isInteger(index) && String(index) === segment ? value[index] : undefined;
  }
  return isRecord(value) && Object.hasOwn(value, segment) && isJsonValue(value[segment])
    ? value[segment]
    : undefined;
}

export async function readStatePath(
  runId: string,
  seq: number,
  path: string,
  options: TraceStoreOptions = {},
): Promise<JsonValue> {
  let current = await readStateAt(runId, seq, options);
  for (const segment of decodePointer(path)) {
    const child = childAt(current, segment);
    if (child === undefined) {
      throw new TraceDataError("STATE_NOT_FOUND", `State path ${path} was not found.`);
    }
    current = child;
  }
  return current;
}
