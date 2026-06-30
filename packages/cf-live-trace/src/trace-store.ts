import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { detectBodyFormat, type TraceBodyFormat } from "./trace-compact.js";
import type { CfLiveTraceTarget, LiveTraceEvent } from "./types.js";

const SAPTOOLS_DIR_NAME = ".saptools";
const CF_LIVE_TRACE_DIR_NAME = "cf-live-trace";
const SESSIONS_DIR_NAME = "sessions";
const EVENTS_DIR_NAME = "events";
const MANIFEST_FILE_NAME = "manifest.json";
const TRACE_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_ID_PATTERN = /^s[0-9a-f]{8}$/;
const REQUEST_ID_PATTERN = /^r[0-9a-f]{8}$/;

export interface TraceTargetIdentity {
  readonly region?: string;
  readonly apiEndpoint?: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
  readonly instance: string;
}

export interface TraceSession {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly target: TraceTargetIdentity;
  readonly directory: string;
  readonly eventsDirectory: string;
  readonly manifestPath: string;
}

export interface StoredTraceEvent {
  readonly version: 1;
  readonly sessionId: string;
  readonly requestId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly target: TraceTargetIdentity;
  readonly requestBodyFormat: TraceBodyFormat;
  readonly responseBodyFormat: TraceBodyFormat;
  readonly event: LiveTraceEvent;
}

export interface StoredTraceEventFile extends StoredTraceEvent {
  readonly backupPath: string;
}

export interface TraceSessionSummary {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly target: TraceTargetIdentity;
  readonly eventCount: number;
  readonly directory: string;
}

export interface CreateTraceSessionInput {
  readonly target: CfLiveTraceTarget;
}

export interface TraceStoreOptions {
  readonly saptoolsRoot?: string;
  readonly now?: () => Date;
  readonly sessionId?: string;
  readonly requestId?: () => string;
}

interface StoredTraceSessionManifest {
  readonly version: 1;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly target: TraceTargetIdentity;
}

export function traceSessionsRoot(saptoolsRoot?: string): string {
  return join(saptoolsRoot ?? join(homedir(), SAPTOOLS_DIR_NAME), CF_LIVE_TRACE_DIR_NAME, SESSIONS_DIR_NAME);
}

export async function createTraceSession(
  input: CreateTraceSessionInput,
  options: TraceStoreOptions = {},
): Promise<TraceSession> {
  await pruneTraceSessions(options);
  const sessionId = resolveSessionId(options.sessionId);
  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const target = toTargetIdentity(input.target);
  const directory = sessionDirectory(sessionId, options.saptoolsRoot);
  const eventsDirectory = join(directory, EVENTS_DIR_NAME);
  const manifestPath = join(directory, MANIFEST_FILE_NAME);
  await mkdir(eventsDirectory, { recursive: true, mode: 0o700 });
  await writeJsonFile(manifestPath, { version: 1, sessionId, createdAt, target });
  return { sessionId, createdAt, target, directory, eventsDirectory, manifestPath };
}

export async function writeTraceEvent(
  session: TraceSession,
  event: LiveTraceEvent,
  options: TraceStoreOptions = {},
): Promise<StoredTraceEventFile> {
  const now = options.now?.() ?? new Date();
  const requestId = resolveRequestId(options.requestId?.());
  const record: StoredTraceEvent = {
    version: 1,
    sessionId: session.sessionId,
    requestId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TRACE_TTL_MS).toISOString(),
    target: session.target,
    requestBodyFormat: detectBodyFormat(event.requestBodyPreview, event.requestHeaders),
    responseBodyFormat: detectBodyFormat(event.responseBodyPreview, event.responseHeaders),
    event,
  };
  const backupPath = join(session.eventsDirectory, eventFileName(record, now));
  await mkdir(session.eventsDirectory, { recursive: true, mode: 0o700 });
  await writeJsonFile(backupPath, record);
  return { ...record, backupPath };
}

export async function readTraceEvent(
  sessionId: string,
  requestId: string,
  options: TraceStoreOptions = {},
): Promise<StoredTraceEventFile> {
  const events = await listTraceEvents(sessionId, options);
  const record = events.find((item) => item.requestId === requestId);
  if (record === undefined) {
    throw new Error("Saved trace request not found or expired");
  }
  return record;
}

export async function listTraceEvents(
  sessionId: string,
  options: TraceStoreOptions = {},
): Promise<readonly StoredTraceEventFile[]> {
  const resolvedSessionId = resolveSessionId(sessionId);
  await pruneTraceSessions(options);
  const entries = await listEventFilePaths(resolvedSessionId, options.saptoolsRoot);
  const records = await Promise.all(entries.map(async (path) => await readStoredTraceEvent(path)));
  return records
    .filter((item): item is StoredTraceEventFile => item !== undefined)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.requestId.localeCompare(right.requestId));
}

export async function listTraceSessions(options: TraceStoreOptions = {}): Promise<readonly TraceSessionSummary[]> {
  await pruneTraceSessions(options);
  const sessionIds = await listSessionIds(options.saptoolsRoot);
  const summaries = await Promise.all(sessionIds.map(async (sessionId) => await readSessionSummary(sessionId, options)));
  return summaries
    .filter((summary): summary is TraceSessionSummary => summary !== undefined)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function pruneTraceSessions(options: TraceStoreOptions = {}): Promise<number> {
  const sessionIds = await listSessionIds(options.saptoolsRoot);
  const now = (options.now?.() ?? new Date()).getTime();
  let removed = 0;
  for (const sessionId of sessionIds) {
    removed += await pruneSession(sessionId, now, options.saptoolsRoot);
  }
  return removed;
}

function toTargetIdentity(target: CfLiveTraceTarget): TraceTargetIdentity {
  return {
    ...(target.region === undefined ? {} : { region: target.region }),
    ...(target.apiEndpoint === undefined ? {} : { apiEndpoint: target.apiEndpoint }),
    org: target.org,
    space: target.space,
    app: target.app,
    instance: String(target.instanceIndex ?? 0),
  };
}

async function readSessionSummary(
  sessionId: string,
  options: TraceStoreOptions,
): Promise<TraceSessionSummary | undefined> {
  const manifest = await readStoredManifest(manifestPath(sessionId, options.saptoolsRoot));
  if (manifest === undefined) {
    return undefined;
  }
  const eventCount = (await listEventFilePaths(sessionId, options.saptoolsRoot)).length;
  return {
    sessionId,
    createdAt: manifest.createdAt,
    target: manifest.target,
    eventCount,
    directory: sessionDirectory(sessionId, options.saptoolsRoot),
  };
}

async function pruneSession(sessionId: string, now: number, saptoolsRoot?: string): Promise<number> {
  const manifest = await readStoredManifest(manifestPath(sessionId, saptoolsRoot));
  const eventPaths = await listEventFilePaths(sessionId, saptoolsRoot);
  let removed = 0;
  let remaining = 0;
  for (const path of eventPaths) {
    const record = await readStoredTraceEvent(path);
    if (record === undefined || Date.parse(record.expiresAt) <= now) {
      await rm(path, { force: true });
      removed += 1;
    } else {
      remaining += 1;
    }
  }
  if (remaining === 0 && isManifestExpiredOrMissing(manifest, now)) {
    await rm(sessionDirectory(sessionId, saptoolsRoot), { recursive: true, force: true });
  }
  return removed;
}

function isManifestExpiredOrMissing(manifest: StoredTraceSessionManifest | undefined, now: number): boolean {
  if (manifest === undefined) {
    return true;
  }
  return Date.parse(manifest.createdAt) + TRACE_TTL_MS <= now;
}

async function listSessionIds(saptoolsRoot?: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(traceSessionsRoot(saptoolsRoot), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && SESSION_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

async function listEventFilePaths(sessionId: string, saptoolsRoot?: string): Promise<readonly string[]> {
  try {
    const directory = eventsDirectory(sessionId, saptoolsRoot);
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(directory, entry.name));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

async function readStoredManifest(path: string): Promise<StoredTraceSessionManifest | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isStoredManifest(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function readStoredTraceEvent(path: string): Promise<StoredTraceEventFile | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isStoredTraceEvent(parsed) ? { ...parsed, backupPath: path } : undefined;
  } catch {
    return undefined;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid.toString()}-${randomHex(4)}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

function eventFileName(record: StoredTraceEvent, now: Date): string {
  const parts = [
    targetSlug(record.target),
    record.sessionId,
    record.requestId,
    fileTimestamp(now),
  ].join("-");
  return `${parts}.json`;
}

function targetSlug(target: TraceTargetIdentity): string {
  const regionOrApi = target.region ?? target.apiEndpoint ?? "api";
  return [regionOrApi, target.org, target.space, target.app].map(sanitizePathPart).join("-");
}

function sanitizePathPart(value: string): string {
  const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length === 0 ? "unknown" : sanitized;
}

function fileTimestamp(now: Date): string {
  return now.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
}

function sessionDirectory(sessionId: string, saptoolsRoot?: string): string {
  return join(traceSessionsRoot(saptoolsRoot), sessionId);
}

function eventsDirectory(sessionId: string, saptoolsRoot?: string): string {
  return join(sessionDirectory(sessionId, saptoolsRoot), EVENTS_DIR_NAME);
}

function manifestPath(sessionId: string, saptoolsRoot?: string): string {
  return join(sessionDirectory(sessionId, saptoolsRoot), MANIFEST_FILE_NAME);
}

function resolveSessionId(value: string | undefined): string {
  const sessionId = value ?? `s${randomHex(4)}`;
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("Invalid trace session id");
  }
  return sessionId;
}

function resolveRequestId(value: string | undefined): string {
  const requestId = value ?? `r${randomHex(4)}`;
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error("Invalid trace request id");
  }
  return requestId;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function isStoredManifest(value: unknown): value is StoredTraceSessionManifest {
  return (
    isRecord(value) &&
    value["version"] === 1 &&
    typeof value["sessionId"] === "string" &&
    typeof value["createdAt"] === "string" &&
    isTraceTargetIdentity(value["target"])
  );
}

function isStoredTraceEvent(value: unknown): value is StoredTraceEvent {
  return (
    isRecord(value) &&
    value["version"] === 1 &&
    typeof value["sessionId"] === "string" &&
    typeof value["requestId"] === "string" &&
    typeof value["createdAt"] === "string" &&
    typeof value["expiresAt"] === "string" &&
    isTraceTargetIdentity(value["target"]) &&
    isTraceBodyFormat(value["requestBodyFormat"]) &&
    isTraceBodyFormat(value["responseBodyFormat"]) &&
    isLiveTraceEvent(value["event"])
  );
}

function isTraceTargetIdentity(value: unknown): value is TraceTargetIdentity {
  return (
    isRecord(value) &&
    optionalString(value["region"]) &&
    optionalString(value["apiEndpoint"]) &&
    typeof value["org"] === "string" &&
    typeof value["space"] === "string" &&
    typeof value["app"] === "string" &&
    typeof value["instance"] === "string"
  );
}

function isLiveTraceEvent(value: unknown): value is LiveTraceEvent {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["timestamp"] === "string" &&
    typeof value["appId"] === "string" &&
    typeof value["method"] === "string" &&
    typeof value["normalizedUrl"] === "string" &&
    value["source"] === "runtime-http"
  );
}

function isTraceBodyFormat(value: unknown): value is TraceBodyFormat {
  return (
    value === "empty" ||
    value === "json" ||
    value === "xml" ||
    value === "html" ||
    value === "form" ||
    value === "text" ||
    value === "binary" ||
    value === "unknown"
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error["code"] === code;
}
