import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_TUNNEL_FALLBACK_BUDGET_MS } from "../config.js";

import { killTunnelProcess, probeLocalPort } from "./process.js";

const DEFAULT_ESTABLISHING_STALE_MS = 2 * DEFAULT_TUNNEL_FALLBACK_BUDGET_MS;
const DEFAULT_POLL_INTERVAL_MS = 300;

export interface TunnelOrgKey {
  readonly apiEndpoint: string;
  readonly orgName: string;
}

export interface TunnelEstablishingRecord {
  readonly version: 1;
  readonly status: "establishing";
  readonly host: string;
  readonly startedAt: string;
  readonly ownerPid: number;
  readonly orgKey: TunnelOrgKey;
}

export interface TunnelReadyRecord {
  readonly version: 1;
  readonly status: "ready";
  readonly host: string;
  readonly localPort: number;
  readonly pid: number;
  readonly app: string;
  readonly orgKey: TunnelOrgKey;
  readonly expiresAt: string;
}

export type TunnelCacheRecord = TunnelEstablishingRecord | TunnelReadyRecord;

export type ClaimResult =
  | { readonly outcome: "claimed" }
  | { readonly outcome: "already-ready"; readonly record: TunnelReadyRecord }
  | { readonly outcome: "wait" };

export interface TunnelCacheOptions {
  readonly saptoolsRoot?: string;
  readonly now?: () => Date;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly probePort?: (port: number) => Promise<boolean>;
  readonly killProcess?: (pid: number | undefined) => void;
  /** How long an establishing marker may exist before an alive owner is presumed hung. */
  readonly staleAfterMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH means the process is genuinely gone; any other outcome (e.g.
    // EPERM for a process owned by another user) means it still exists.
    return isRecord(error) && error["code"] !== "ESRCH";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function tunnelCacheRoot(saptoolsRoot?: string): string {
  return join(saptoolsRoot ?? join(homedir(), ".saptools"), "cf-hana", "tunnel");
}

export function tunnelCacheKey(host: string): string {
  return createHash("sha256").update(host).digest("hex");
}

function tunnelCachePath(host: string, saptoolsRoot?: string): string {
  return join(tunnelCacheRoot(saptoolsRoot), `${tunnelCacheKey(host)}.json`);
}

function isOrgKey(value: unknown): value is TunnelOrgKey {
  return (
    isRecord(value) &&
    typeof value["apiEndpoint"] === "string" &&
    typeof value["orgName"] === "string"
  );
}

function hasEstablishingFields(value: Record<string, unknown>): boolean {
  return (
    value["status"] === "establishing" &&
    typeof value["host"] === "string" &&
    typeof value["startedAt"] === "string" &&
    typeof value["ownerPid"] === "number" &&
    isOrgKey(value["orgKey"])
  );
}

function hasReadyFields(value: Record<string, unknown>): boolean {
  return (
    value["status"] === "ready" &&
    typeof value["host"] === "string" &&
    typeof value["localPort"] === "number" &&
    typeof value["pid"] === "number" &&
    typeof value["app"] === "string" &&
    typeof value["expiresAt"] === "string" &&
    isOrgKey(value["orgKey"])
  );
}

function isTunnelCacheRecord(value: unknown): value is TunnelCacheRecord {
  return (
    isRecord(value) &&
    value["version"] === 1 &&
    (hasEstablishingFields(value) || hasReadyFields(value))
  );
}

async function parseTunnelCacheFile(path: string): Promise<TunnelCacheRecord | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    return isTunnelCacheRecord(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Read the current cache entry for a host, or `undefined` if absent/malformed. */
export async function readTunnelCacheEntry(
  host: string,
  options: TunnelCacheOptions = {},
): Promise<TunnelCacheRecord | undefined> {
  const entry = await parseTunnelCacheFile(tunnelCachePath(host, options.saptoolsRoot));
  return entry?.host === host ? entry : undefined;
}

function isExpired(entry: TunnelReadyRecord, now: Date): boolean {
  const expiresAt = Date.parse(entry.expiresAt);
  return !Number.isFinite(expiresAt) || now.getTime() >= expiresAt;
}

/**
 * The thorough reuse check: pid alive, local port still accepting
 * connections, and not past its recorded expiry. A local forward's listener
 * can outlive a dead remote SSH leg, so none of these alone is sufficient.
 */
export async function isTunnelUsable(
  entry: TunnelReadyRecord,
  options: TunnelCacheOptions = {},
): Promise<boolean> {
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  if (!isAlive(entry.pid)) {
    return false;
  }
  if (isExpired(entry, options.now?.() ?? new Date())) {
    return false;
  }
  const probePort = options.probePort ?? probeLocalPort;
  return await probePort(entry.localPort);
}

function isEstablishingStale(entry: TunnelEstablishingRecord, options: TunnelCacheOptions): boolean {
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  if (!isAlive(entry.ownerPid)) {
    return true;
  }
  const startedAt = Date.parse(entry.startedAt);
  if (!Number.isFinite(startedAt)) {
    return true;
  }
  const now = options.now?.() ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_ESTABLISHING_STALE_MS;
  return now.getTime() - startedAt >= staleAfterMs;
}

async function writeEstablishingMarker(
  host: string,
  ownerPid: number,
  orgKey: TunnelOrgKey,
  options: TunnelCacheOptions,
): Promise<boolean> {
  const root = tunnelCacheRoot(options.saptoolsRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const record: TunnelEstablishingRecord = {
    version: 1,
    status: "establishing",
    host,
    startedAt: (options.now?.() ?? new Date()).toISOString(),
    ownerPid,
    orgKey,
  };
  try {
    await writeFile(tunnelCachePath(host, options.saptoolsRoot), `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return true;
  } catch (error) {
    if (isRecord(error) && error["code"] === "EEXIST") {
      return false;
    }
    throw error;
  }
}

/**
 * Attempts to become the sole establisher for a host. Exclusive file
 * creation is the only real "who goes first" signal — a plain temp-then-
 * rename write (as the existing metadata cache uses) cannot resolve two
 * processes racing to establish the same host's tunnel.
 */
export async function claimEstablishing(
  host: string,
  ownerPid: number,
  orgKey: TunnelOrgKey,
  options: TunnelCacheOptions = {},
): Promise<ClaimResult> {
  if (await writeEstablishingMarker(host, ownerPid, orgKey, options)) {
    return { outcome: "claimed" };
  }
  const existing = await readTunnelCacheEntry(host, options);
  if (existing === undefined) {
    // Disappeared between our failed create and this read (the previous
    // owner just finalized as failed) - the slot is free again.
    return (await writeEstablishingMarker(host, ownerPid, orgKey, options))
      ? { outcome: "claimed" }
      : { outcome: "wait" };
  }
  if (existing.status === "ready") {
    return { outcome: "already-ready", record: existing };
  }
  if (!isEstablishingStale(existing, options)) {
    return { outcome: "wait" };
  }
  await rm(tunnelCachePath(host, options.saptoolsRoot), { force: true });
  // The takeover still ends in the same exclusive create; if another
  // process wins this tiny remove-then-recreate window, back off and let
  // the caller poll rather than looping to retry the takeover itself.
  return (await writeEstablishingMarker(host, ownerPid, orgKey, options))
    ? { outcome: "claimed" }
    : { outcome: "wait" };
}

/** Polls for the current owner's outcome: the ready record, or `undefined` on failure/timeout. */
export async function waitForEstablishment(
  host: string,
  deadline: number,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  options: TunnelCacheOptions = {},
): Promise<TunnelReadyRecord | undefined> {
  for (;;) {
    const entry = await readTunnelCacheEntry(host, options);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.status === "ready") {
      return entry;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return undefined;
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}

/** The winning establisher's success path: atomic write, replacing the marker. */
export async function finalizeEstablishingReady(
  host: string,
  record: Omit<TunnelReadyRecord, "version" | "status" | "host">,
  options: TunnelCacheOptions = {},
): Promise<void> {
  const root = tunnelCacheRoot(options.saptoolsRoot);
  const path = tunnelCachePath(host, options.saptoolsRoot);
  const tempPath = `${path}.tmp-${String(process.pid)}`;
  const stored: TunnelReadyRecord = { version: 1, status: "ready", host, ...record };
  await mkdir(root, { recursive: true, mode: 0o700 });
  await rm(tempPath, { force: true });
  await writeFile(tempPath, `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, path);
}

/**
 * The winning establisher's clean-failure path: the marker is removed
 * entirely, never left in place - a stranded `establishing` record would
 * force every waiter to burn its own budget for no reason.
 */
export async function finalizeEstablishingFailed(
  host: string,
  options: TunnelCacheOptions = {},
): Promise<void> {
  await rm(tunnelCachePath(host, options.saptoolsRoot), { force: true });
}

/** Discards a cache entry outright (self-healing after a reuse attempt fails). */
export async function evictTunnelCache(
  host: string,
  options: TunnelCacheOptions = {},
): Promise<void> {
  await rm(tunnelCachePath(host, options.saptoolsRoot), { force: true });
}

function sameOrg(a: TunnelOrgKey, b: TunnelOrgKey): boolean {
  return a.apiEndpoint === b.apiEndpoint && a.orgName === b.orgName;
}

async function reapOneFile(
  path: string,
  currentOrgKey: TunnelOrgKey,
  options: TunnelCacheOptions,
): Promise<void> {
  const entry = await parseTunnelCacheFile(path);
  if (entry === undefined) {
    return;
  }
  const killProcess = options.killProcess ?? killTunnelProcess;
  if (entry.status === "establishing") {
    if (isEstablishingStale(entry, options)) {
      await rm(path, { force: true });
    }
    // A live, non-stale establishing marker is left alone regardless of
    // org: establishment is transient and will resolve on its own, and
    // reaping it here could destroy a different process's in-flight work.
    return;
  }
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  if (!isAlive(entry.pid)) {
    await rm(path, { force: true });
    return;
  }
  const now = options.now?.() ?? new Date();
  if (isExpired(entry, now) || !sameOrg(entry.orgKey, currentOrgKey)) {
    killProcess(entry.pid);
    await rm(path, { force: true });
  }
}

/**
 * Cheap pass (pid liveness + expiry only, no TCP probe) run on every
 * `Connection.open()`: reaps dead entries of either status, reaps an alive
 * but age-stale establishing marker, and closes a live `ready` tunnel the
 * moment it is expired or tagged for a different org than this invocation
 * is currently targeting - regardless of its remaining TTL, so a different
 * client's landscape never has an unattended live SSH path left open.
 */
export async function reapStaleAndCrossOrgTunnels(
  currentOrgKey: TunnelOrgKey,
  options: TunnelCacheOptions = {},
): Promise<void> {
  const root = tunnelCacheRoot(options.saptoolsRoot);
  let files: readonly string[];
  try {
    files = await readdir(root);
  } catch {
    return;
  }
  await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        await reapOneFile(join(root, file), currentOrgKey, options);
      }),
  );
}
