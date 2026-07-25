import * as cf from "../cf.js";
import type { CfExecContext } from "../cf.js";
import {
  DEFAULT_TUNNEL_CANDIDATE_TIMEOUT_MS,
  DEFAULT_TUNNEL_FALLBACK_BUDGET_MS,
  DEFAULT_TUNNEL_KEEPALIVE_SECONDS,
  DEFAULT_TUNNEL_MAX_CANDIDATES,
} from "../config.js";
import type { SapCredentials } from "../config.js";
import type { DriverConnectParams, DriverConnection, HanaDriver } from "../driver/types.js";
import { CfHanaError } from "../errors.js";
import type { SelectorSource } from "../types.js";

import {
  claimEstablishing,
  evictTunnelCache,
  finalizeEstablishingFailed,
  finalizeEstablishingReady,
  isTunnelUsable,
  reapStaleAndCrossOrgTunnels,
  readTunnelCacheEntry,
  waitForEstablishment,
} from "./cache.js";
import type { TunnelCacheOptions, TunnelOrgKey, TunnelReadyRecord } from "./cache.js";
import { buildCandidateList } from "./candidates.js";
import { isConnectivityFailure, isUnattributedQueryFailure } from "./classifier.js";
import {
  killTunnelProcess,
  spawnTunnel,
  withScopedCfSession,
} from "./process.js";
import type { SpawnTunnelDeps, SpawnTunnelResult } from "./process.js";

/**
 * Everything `connectWithTunnelFallback` needs from `ConnectionConfig`,
 * declared locally rather than imported from `../connection.js` — that
 * module calls this one, and importing `ConnectionConfig` back from it
 * would create an import cycle. Kept structurally identical to (a subset
 * of) `ConnectionConfig` so callers pass their config object unchanged.
 */
export interface TunnelFallbackConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly schema: string;
  readonly certificate: string;
  readonly connectTimeoutMs: number;
  readonly appName: string;
  readonly orgName: string;
  readonly spaceName: string;
  readonly apiEndpoint: string;
  readonly selectorSource: SelectorSource;
  readonly tunnelMode: "auto" | "always";
  readonly refreshTunnel: boolean;
  readonly sapCredentials?: SapCredentials;
  readonly onTunnelStatus?: (message: string) => void;
}

export interface TunnelFallbackOverrides {
  readonly cache?: TunnelCacheOptions;
  readonly process?: SpawnTunnelDeps;
}

const EXPIRY_SAFETY_MARGIN_MS = 30_000;

function directParamsOf(config: TunnelFallbackConfig): DriverConnectParams {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    schema: config.schema,
    certificate: config.certificate,
    connectTimeoutMs: config.connectTimeoutMs,
  };
}

function tunneledParams(directParams: DriverConnectParams, localPort: number): DriverConnectParams {
  return { ...directParams, host: "127.0.0.1", port: localPort, servername: directParams.host };
}

function orgKeyOf(config: TunnelFallbackConfig): TunnelOrgKey {
  return { apiEndpoint: config.apiEndpoint, orgName: config.orgName };
}

function tunnelExpiryIso(): string {
  return new Date(
    Date.now() + DEFAULT_TUNNEL_KEEPALIVE_SECONDS * 1000 - EXPIRY_SAFETY_MARGIN_MS,
  ).toISOString();
}

async function discardQuietly(work: Promise<unknown>): Promise<void> {
  await work.catch(() => {
    // Best-effort cache/cleanup write; never let it block a connection.
  });
}

/**
 * Whether a failed connect-and-setup attempt means the tunnel itself isn't
 * trustworthy (should be discarded) rather than genuinely proven and just
 * hitting an unrelated, actionable error. Beyond the classified connectivity
 * failures, a `QueryError` carrying neither a `databaseCode` nor a `sqlState`
 * never got a real SQL-level response from HANA - it looks like a transport
 * failure (the connection died right after opening) disguised as a
 * `QueryError`, not a genuine rejection like "schema not found" (which
 * always carries one of these).
 */
function shouldDiscardTunnel(error: unknown): boolean {
  return isConnectivityFailure(error) || isUnattributedQueryFailure(error);
}

/**
 * Connects through an already-known-ready tunnel record. A bare TCP-connect
 * success on an SSH local forward does not prove the remote leg is still
 * alive, so a failure here that looks untrustworthy (see
 * `shouldDiscardTunnel`) evicts the entry and reports "no usable cache"
 * rather than surfacing the error - the caller falls through to fresh
 * discovery. Any other failure proves the tunnel itself works, so it is left
 * cached and the error is rethrown unchanged.
 */
async function tryReadyRecord(
  record: TunnelReadyRecord,
  driver: HanaDriver,
  config: TunnelFallbackConfig,
  directParams: DriverConnectParams,
  cacheOptions: TunnelCacheOptions,
): Promise<DriverConnection | undefined> {
  try {
    const connection = await driver.connect(tunneledParams(directParams, record.localPort));
    config.onTunnelStatus?.(`connected via SSH tunnel through ${record.app}`);
    return connection;
  } catch (error) {
    if (shouldDiscardTunnel(error)) {
      await discardQuietly(evictTunnelCache(config.host, cacheOptions));
      return undefined;
    }
    throw error;
  }
}

/** The target app, plus a cached "last worked" hint app if different - no `cf apps` I/O. */
function knownCandidates(targetAppName: string, hintApp: string | undefined): readonly string[] {
  return hintApp === undefined || hintApp === targetAppName
    ? [targetAppName]
    : [targetAppName, hintApp];
}

async function discoverAppsStdout(
  ctx: CfExecContext | undefined,
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    return ctx === undefined ? await cf.cfAppsDirect(timeoutMs) : await cf.cfApps(ctx, timeoutMs);
  } catch {
    return;
  }
}

/**
 * Only called once the known candidates (target app, cached hint app) have
 * already been tried and failed - `cf apps` against a large space has been
 * measured at ~20s, nearly the entire shared budget on its own, so it must
 * never run before a cheaper, already-known candidate gets a chance, and it
 * must be bounded to whatever budget actually remains rather than retried
 * with the default (60s x 3-attempt) policy: a slow-but-eventually-
 * successful call inside an already-tight remaining budget would only get
 * slower if retried.
 */
async function discoverExtraCandidates(
  config: TunnelFallbackConfig,
  ctx: CfExecContext | undefined,
  alreadyTried: readonly string[],
  deadline: number,
): Promise<readonly string[]> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return [];
  }
  const stdout = await discoverAppsStdout(ctx, remainingMs);
  const base = buildCandidateList(config.appName, stdout, DEFAULT_TUNNEL_MAX_CANDIDATES);
  return base.filter((app) => !alreadyTried.includes(app));
}

async function finalizeCandidateConnection(
  app: string,
  spawned: SpawnTunnelResult,
  driver: HanaDriver,
  config: TunnelFallbackConfig,
  directParams: DriverConnectParams,
  cacheOptions: TunnelCacheOptions,
): Promise<DriverConnection | undefined> {
  const readyRecord = {
    localPort: spawned.localPort,
    pid: spawned.pid,
    app,
    orgKey: orgKeyOf(config),
    expiresAt: tunnelExpiryIso(),
  };
  try {
    const connection = await driver.connect(tunneledParams(directParams, spawned.localPort));
    await discardQuietly(finalizeEstablishingReady(config.host, readyRecord, cacheOptions));
    config.onTunnelStatus?.(`connected via SSH tunnel through ${app}`);
    return connection;
  } catch (error) {
    if (shouldDiscardTunnel(error)) {
      await discardQuietly(finalizeEstablishingFailed(config.host, cacheOptions));
      killTunnelProcess(spawned.pid);
      return undefined;
    }
    // The network path is proven even though this specific statement/setup
    // failed for an unrelated reason - keep the tunnel, surface the error.
    await discardQuietly(finalizeEstablishingReady(config.host, readyRecord, cacheOptions));
    throw error;
  }
}

async function tryCandidate(
  app: string,
  ctx: CfExecContext | undefined,
  driver: HanaDriver,
  config: TunnelFallbackConfig,
  directParams: DriverConnectParams,
  deadline: number,
  overrides: TunnelFallbackOverrides,
): Promise<DriverConnection | undefined> {
  const cacheOptions = overrides.cache ?? {};
  config.onTunnelStatus?.(`trying to reach ${config.host} via app ${app}...`);
  const claim = await claimEstablishing(config.host, process.pid, orgKeyOf(config), cacheOptions);

  if (claim.outcome === "already-ready") {
    return await tryReadyRecord(claim.record, driver, config, directParams, cacheOptions);
  }
  if (claim.outcome === "wait") {
    // Bounded to the same per-candidate ceiling a fresh establishment gets,
    // not the full remaining shared deadline: waitForEstablishment only
    // ever gives up once its own deadline is spent, so passing the full
    // deadline through would leave nothing for runCandidateLoop's own
    // iteration to try again once this wait doesn't pan out. Since the
    // tunnel cache is keyed by host (not by candidate app), "try again"
    // here means a further claimEstablishing call against the same
    // marker gets a chance to run - which only meaningfully differs from
    // this same wait if the marker's owner pid has died in the meantime
    // (claimEstablishing's staleness check reclaims a dead-owner marker
    // immediately, regardless of age); it is not an independent attempt
    // through a different app.
    const waitDeadline = Math.min(deadline, Date.now() + DEFAULT_TUNNEL_CANDIDATE_TIMEOUT_MS);
    const ready = await waitForEstablishment(config.host, waitDeadline, undefined, cacheOptions);
    return ready === undefined
      ? undefined
      : await tryReadyRecord(ready, driver, config, directParams, cacheOptions);
  }

  // Not caught here: a config error (e.g. an invalid keepalive value) is
  // static across every candidate, so it should abort the whole attempt
  // instead of being silently retried candidate-by-candidate.
  const spawned = await spawnTunnel(
    {
      cfHome: ctx?.cfHome,
      app,
      hanaHost: config.host,
      hanaPort: config.port,
      keepaliveSeconds: DEFAULT_TUNNEL_KEEPALIVE_SECONDS,
      deadline,
      candidateTimeoutMs: DEFAULT_TUNNEL_CANDIDATE_TIMEOUT_MS,
    },
    {
      ...overrides.process,
      onFailureDiagnostic: (message) => {
        config.onTunnelStatus?.(`tunnel via ${app} failed: ${message}`);
      },
    },
  );

  if (spawned === undefined) {
    await discardQuietly(finalizeEstablishingFailed(config.host, cacheOptions));
    return undefined;
  }
  return await finalizeCandidateConnection(app, spawned, driver, config, directParams, cacheOptions);
}

async function tryCachedTunnel(
  driver: HanaDriver,
  config: TunnelFallbackConfig,
  directParams: DriverConnectParams,
  cacheOptions: TunnelCacheOptions,
): Promise<{ readonly connection: DriverConnection | undefined; readonly hintApp: string | undefined }> {
  if (config.refreshTunnel) {
    // Not just "skip reuse": an un-evicted stale record would still be
    // sitting there as a "ready" entry, and claimEstablishing's own
    // already-ready detection (meant for a *different* invocation finishing
    // concurrently) would hand it right back out during discovery below.
    const superseded = await readTunnelCacheEntry(config.host, cacheOptions);
    await discardQuietly(evictTunnelCache(config.host, cacheOptions));
    if (superseded?.status === "ready") {
      // The tunnel this refresh supersedes would otherwise keep running,
      // consuming a live SSH session, until its own keepalive naturally
      // elapses (up to DEFAULT_TUNNEL_KEEPALIVE_SECONDS later).
      (cacheOptions.killProcess ?? killTunnelProcess)(superseded.pid);
    }
    return { connection: undefined, hintApp: undefined };
  }
  const entry = await readTunnelCacheEntry(config.host, cacheOptions);
  if (entry?.status !== "ready") {
    return { connection: undefined, hintApp: undefined };
  }
  if (!(await isTunnelUsable(entry, cacheOptions))) {
    await discardQuietly(evictTunnelCache(config.host, cacheOptions));
    return { connection: undefined, hintApp: entry.app };
  }
  const connection = await tryReadyRecord(entry, driver, config, directParams, cacheOptions);
  return { connection, hintApp: entry.app };
}

async function tryDirectConnect(
  driver: HanaDriver,
  config: TunnelFallbackConfig,
  directParams: DriverConnectParams,
): Promise<{ readonly connection: DriverConnection | undefined; readonly directError: unknown }> {
  if (config.tunnelMode !== "auto") {
    return { connection: undefined, directError: undefined };
  }
  // A fallback is available for this attempt, so a silently-hanging (rather
  // than actively refused) direct connection should not be allowed to
  // consume the full connectTimeoutMs before the tunnel path even gets a
  // chance - that would risk an ~85s worst case (60s direct + 25s tunnel
  // budget) instead of a bounded ~40s. Capped at the same ceiling a single
  // tunnel candidate gets, so neither side of the fallback decision can
  // alone dominate it; never widens an already-shorter configured timeout.
  const boundedDirectParams: DriverConnectParams = {
    ...directParams,
    connectTimeoutMs: Math.min(directParams.connectTimeoutMs, DEFAULT_TUNNEL_CANDIDATE_TIMEOUT_MS),
  };
  try {
    return { connection: await driver.connect(boundedDirectParams), directError: undefined };
  } catch (error) {
    if (!isConnectivityFailure(error)) {
      throw error;
    }
    return { connection: undefined, directError: error };
  }
}

function buildExhaustionError(host: string, directError: unknown, candidates: readonly string[]): unknown {
  if (directError !== undefined) {
    return directError;
  }
  return new CfHanaError(
    "CONNECTION",
    `Could not establish an SSH tunnel to ${host} through any candidate app ` +
      `(tried: ${candidates.length > 0 ? candidates.join(", ") : "none"})`,
  );
}

interface CandidateLoopResult {
  readonly connection: DriverConnection | undefined;
  readonly candidatesTried: readonly string[];
}

async function tryCandidateList(
  apps: readonly string[],
  ctx: CfExecContext | undefined,
  driver: HanaDriver,
  config: TunnelFallbackConfig,
  directParams: DriverConnectParams,
  deadline: number,
  overrides: TunnelFallbackOverrides,
  tried: string[],
): Promise<DriverConnection | undefined> {
  for (const app of apps) {
    if (Date.now() >= deadline) {
      return undefined;
    }
    tried.push(app);
    const connection = await tryCandidate(app, ctx, driver, config, directParams, deadline, overrides);
    if (connection !== undefined) {
      return connection;
    }
  }
  return undefined;
}

async function runCandidateLoop(
  ctx: CfExecContext | undefined,
  driver: HanaDriver,
  config: TunnelFallbackConfig,
  directParams: DriverConnectParams,
  deadline: number,
  hintApp: string | undefined,
  overrides: TunnelFallbackOverrides,
): Promise<CandidateLoopResult> {
  const tried: string[] = [];
  const known = knownCandidates(config.appName, hintApp);
  const knownConnection = await tryCandidateList(
    known,
    ctx,
    driver,
    config,
    directParams,
    deadline,
    overrides,
    tried,
  );
  if (knownConnection !== undefined) {
    return { connection: knownConnection, candidatesTried: tried };
  }

  const discovered = await discoverExtraCandidates(config, ctx, tried, deadline);
  const discoveredConnection = await tryCandidateList(
    discovered,
    ctx,
    driver,
    config,
    directParams,
    deadline,
    overrides,
    tried,
  );
  return { connection: discoveredConnection, candidatesTried: tried };
}

/**
 * The tunnel-fallback orchestration `Connection.open` calls instead of
 * `driver.connect()` directly. See `implementation_plan.md` for the full
 * design rationale (classifier reuse points, cache-first check in both
 * modes, self-healing reuse, shared deadline, mode-dependent exhaustion).
 */
export async function connectWithTunnelFallback(
  driver: HanaDriver,
  config: TunnelFallbackConfig,
  overrides: TunnelFallbackOverrides = {},
): Promise<DriverConnection> {
  const directParams = directParamsOf(config);
  const cacheOptions = overrides.cache ?? {};

  await discardQuietly(reapStaleAndCrossOrgTunnels(orgKeyOf(config), cacheOptions));

  const cached = await tryCachedTunnel(driver, config, directParams, cacheOptions);
  if (cached.connection !== undefined) {
    return cached.connection;
  }

  const direct = await tryDirectConnect(driver, config, directParams);
  if (direct.connection !== undefined) {
    return direct.connection;
  }

  const deadline = Date.now() + DEFAULT_TUNNEL_FALLBACK_BUDGET_MS;
  const target = {
    apiEndpoint: config.apiEndpoint,
    orgName: config.orgName,
    spaceName: config.spaceName,
  };
  const loopResult = await withScopedCfSession(
    config.selectorSource,
    target,
    config.sapCredentials,
    (ctx) => runCandidateLoop(ctx, driver, config, directParams, deadline, cached.hintApp, overrides),
  );

  if (loopResult.connection !== undefined) {
    return loopResult.connection;
  }
  throw buildExhaustionError(config.host, direct.directError, loopResult.candidatesTried);
}
