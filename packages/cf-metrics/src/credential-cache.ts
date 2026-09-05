import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { isRecord } from "./agg-buckets.js";
import { DEFAULT_CREDENTIAL_TTL_MINUTES, saptoolsRootFromEnv } from "./config.js";
import type { DashboardsCredential, ResolvedTarget } from "./types.js";

/**
 * On-disk reuse of a discovered dashboards credential.
 *
 * Discovering one costs a full Cloud Foundry round trip — login, instance
 * lookup, a bindings listing, and probing the bindings one batch at a time —
 * measured at 30+ seconds on a real tenant, repeated on every command because
 * nothing was remembered between runs. The credential itself does not change
 * between runs: it is a service key's or binding's basic-auth pair, which
 * lives as long as the key or binding does.
 *
 * Storing it is a deliberate trade, made the way this repo already makes it
 * for XSUAA client secrets (`cf-xsuaa`, `~/.saptools/xsuaa-data.json`): a
 * private directory (0700) and file (0600) under the user's own home, the same
 * protection `~/.cf/config.json` gets for the refresh token that could fetch
 * this very credential from the Cloud Controller. Nothing here widens who can
 * obtain the secret; it only saves re-obtaining it. Anyone who would rather
 * not keep it on disk sets `CF_METRICS_CREDENTIAL_CACHE=0`, and
 * `cf-metrics credential clear` removes what is stored.
 *
 * A stale entry is never trusted for long: OpenSearch rejecting it (HTTP
 * 401/403) drops it immediately, and every entry also carries a time-to-live so
 * a secret cannot sit here unused indefinitely.
 */

const CACHE_FILE_NAME = "credentials.json";
const CACHE_FILE_MODE = 0o600;
const CACHE_DIR_MODE = 0o700;
/** Stored `instanceSelector` for a credential discovered without `--service-instance`. */
const AUTO_INSTANCE_SELECTOR = "auto";

interface StoredCredentialEntry {
  readonly region: string;
  readonly apiEndpoint: string;
  readonly org: string;
  readonly space: string;
  /** The `--service-instance` value this was discovered for, or {@link AUTO_INSTANCE_SELECTOR}. */
  readonly instanceSelector: string;
  readonly instance: string;
  readonly source: string;
  readonly dashboardsEndpoint: string;
  readonly username: string;
  readonly password: string;
  readonly cachedAt: string;
  readonly expiresAt: string;
}

interface StoredCredentialCache {
  readonly version: 1;
  readonly entries: readonly StoredCredentialEntry[];
}

/** Which credential a command is asking for; the target plus the instance it was pinned to, if any. */
export interface CredentialCacheKey {
  readonly target: ResolvedTarget;
  /** The `--service-instance` value, or undefined when the instance is auto-discovered. */
  readonly instanceSelector?: string;
}

export interface CredentialCacheOptions {
  readonly saptoolsRoot?: string;
  readonly now?: () => Date;
  readonly ttlMinutes?: number;
}

/** What `credential list` shows: everything except the secret itself. */
export interface CachedCredentialSummary {
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly instance: string;
  readonly source: string;
  readonly dashboardsEndpoint: string;
  readonly cachedAt: string;
  readonly expiresAt: string;
}

const EMPTY_CACHE: StoredCredentialCache = { version: 1, entries: [] };

/** Root override from the environment (see `saptoolsRootFromEnv`), so tests never touch the real `~/.saptools`. */
export function credentialCacheOptionsFromEnv(): CredentialCacheOptions {
  const saptoolsRoot = saptoolsRootFromEnv();
  return saptoolsRoot === undefined ? {} : { saptoolsRoot };
}

function cachePath(saptoolsRoot?: string): string {
  return join(saptoolsRoot ?? join(homedir(), ".saptools"), "cf-metrics", CACHE_FILE_NAME);
}

function isStoredEntry(value: unknown): value is StoredCredentialEntry {
  if (!isRecord(value)) {
    return false;
  }
  const stringKeys: readonly (keyof StoredCredentialEntry)[] = [
    "region",
    "apiEndpoint",
    "org",
    "space",
    "instanceSelector",
    "instance",
    "source",
    "dashboardsEndpoint",
    "username",
    "password",
    "cachedAt",
    "expiresAt",
  ];
  return stringKeys.every((key) => typeof value[key] === "string");
}

/** Read the store, treating a missing, unreadable, or malformed file as empty — the cache is an accelerator, never a dependency. */
async function readStore(path: string): Promise<StoredCredentialCache> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return EMPTY_CACHE;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed["version"] !== 1 || !Array.isArray(parsed["entries"])) {
      return EMPTY_CACHE;
    }
    return { version: 1, entries: parsed["entries"].filter(isStoredEntry) };
  } catch {
    return EMPTY_CACHE;
  }
}

/**
 * Write atomically (temp file + rename) with the file and its directory both
 * private. The explicit `chmod` calls matter: `mkdir`/`writeFile` modes are
 * subject to the umask, and a pre-existing directory or file keeps whatever
 * mode it already had.
 */
async function writeStore(path: string, store: StoredCredentialCache): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: CACHE_DIR_MODE });
  await chmod(directory, CACHE_DIR_MODE);
  const tempPath = `${path}.tmp-${process.pid.toString()}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: CACHE_FILE_MODE });
    await chmod(tempPath, CACHE_FILE_MODE);
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function normalizeEndpoint(apiEndpoint: string): string {
  return apiEndpoint.trim().toLowerCase().replace(/\/+$/, "");
}

function matchesKey(entry: StoredCredentialEntry, key: CredentialCacheKey): boolean {
  if (
    normalizeEndpoint(entry.apiEndpoint) !== normalizeEndpoint(key.target.apiEndpoint) ||
    entry.org !== key.target.org ||
    entry.space !== key.target.space
  ) {
    return false;
  }
  // An entry discovered by auto-detection also serves a later request that
  // names that same instance explicitly — same credential, same instance.
  return key.instanceSelector === undefined
    ? entry.instanceSelector === AUTO_INSTANCE_SELECTOR
    : entry.instance === key.instanceSelector;
}

function isLive(entry: StoredCredentialEntry, nowMs: number): boolean {
  const expires = Date.parse(entry.expiresAt);
  return Number.isFinite(expires) && expires > nowMs;
}

function liveEntries(store: StoredCredentialCache, nowMs: number): readonly StoredCredentialEntry[] {
  return store.entries.filter((entry) => isLive(entry, nowMs));
}

/** The cached credential for this target and instance selection, or undefined when none is live. */
export async function readCachedCredential(
  key: CredentialCacheKey,
  options: CredentialCacheOptions = {},
): Promise<DashboardsCredential | undefined> {
  const store = await readStore(cachePath(options.saptoolsRoot));
  const nowMs = (options.now?.() ?? new Date()).getTime();
  const entry = liveEntries(store, nowMs).find((candidate) => matchesKey(candidate, key));
  if (entry === undefined) {
    return undefined;
  }
  return {
    dashboardsEndpoint: entry.dashboardsEndpoint,
    username: entry.username,
    password: entry.password,
    source: entry.source,
    instance: entry.instance,
  };
}

/** Remember a freshly discovered credential, replacing any earlier entry for the same key and dropping expired ones. */
export async function writeCachedCredential(
  key: CredentialCacheKey,
  credential: DashboardsCredential,
  options: CredentialCacheOptions = {},
): Promise<void> {
  const path = cachePath(options.saptoolsRoot);
  const store = await readStore(path);
  const now = options.now?.() ?? new Date();
  const ttlMinutes = options.ttlMinutes ?? DEFAULT_CREDENTIAL_TTL_MINUTES;
  const entry: StoredCredentialEntry = {
    region: key.target.region,
    apiEndpoint: key.target.apiEndpoint,
    org: key.target.org,
    space: key.target.space,
    instanceSelector: key.instanceSelector ?? AUTO_INSTANCE_SELECTOR,
    instance: credential.instance,
    source: credential.source,
    dashboardsEndpoint: credential.dashboardsEndpoint,
    username: credential.username,
    password: credential.password,
    cachedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
  };
  const kept = liveEntries(store, now.getTime()).filter((candidate) => !matchesKey(candidate, key));
  await writeStore(path, { version: 1, entries: [...kept, entry] });
}

/** Forget the credential for this key — used the moment OpenSearch rejects it. Returns whether anything was removed. */
export async function deleteCachedCredential(key: CredentialCacheKey, options: CredentialCacheOptions = {}): Promise<boolean> {
  const path = cachePath(options.saptoolsRoot);
  const store = await readStore(path);
  const kept = store.entries.filter((candidate) => !matchesKey(candidate, key));
  if (kept.length === store.entries.length) {
    return false;
  }
  await writeStore(path, { version: 1, entries: kept });
  return true;
}

/** Every live cached credential, without its secret, for `credential list`. */
export async function listCachedCredentials(options: CredentialCacheOptions = {}): Promise<readonly CachedCredentialSummary[]> {
  const store = await readStore(cachePath(options.saptoolsRoot));
  const nowMs = (options.now?.() ?? new Date()).getTime();
  return liveEntries(store, nowMs)
    .map((entry) => ({
      region: entry.region,
      org: entry.org,
      space: entry.space,
      instance: entry.instance,
      source: entry.source,
      dashboardsEndpoint: entry.dashboardsEndpoint,
      cachedAt: entry.cachedAt,
      expiresAt: entry.expiresAt,
    }))
    .sort((left, right) =>
      `${left.region}/${left.org}/${left.space}/${left.instance}`.localeCompare(
        `${right.region}/${right.org}/${right.space}/${right.instance}`,
      ),
    );
}

/**
 * Remove the whole cache file, and any half-written temp file beside it.
 * Returns how many live entries it held.
 *
 * The temp sweep is the part that matters: `writeStore` writes
 * `credentials.json.tmp-<pid>` before renaming it into place, so an
 * interruption in that window strands a file holding the basic-auth password
 * in cleartext. Nothing reclaimed it — a later run writes under its own pid —
 * and `credential list` reads only the real file, so the CLI reported the
 * credential as gone while the secret sat on disk indefinitely.
 */
export async function clearCredentialCache(options: CredentialCacheOptions = {}): Promise<number> {
  const path = cachePath(options.saptoolsRoot);
  const store = await readStore(path);
  const nowMs = (options.now?.() ?? new Date()).getTime();
  const count = liveEntries(store, nowMs).length;
  await rm(path, { force: true });
  await removeStrandedTempFiles(path);
  return count;
}

/** Delete every `<cache>.tmp-*` left behind by an interrupted write. */
async function removeStrandedTempFiles(path: string): Promise<void> {
  const directory = dirname(path);
  const prefix = `${CACHE_FILE_NAME}.tmp-`;
  let names: readonly string[];
  try {
    names = await readdir(directory);
  } catch {
    // No directory at all is the normal "nothing cached" case, and an
    // unreadable one must not turn a successful clear into a failure.
    return;
  }
  await Promise.all(
    names
      .filter((name) => name.startsWith(prefix))
      .map(async (name) => {
        await rm(join(directory, name), { force: true });
      }),
  );
}
