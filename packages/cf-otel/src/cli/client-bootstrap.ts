import type { CfExecContext as CoreCfExecContext, CredentialCacheKey, DashboardsCredential, OpenSearchClient, ResolvedTarget } from "@saptools/core";
import {
  createOpenSearchClient,
  deleteCachedCredential,
  discoverDashboardsCredential,
  discoverServiceInstance,
  isAuthRejection,
  printResolvedTarget,
  readCachedCredential,
  resolveTarget,
  writeCachedCredential,
} from "@saptools/core";

import type { CfExecContext } from "../cf.js";
import { CLI_NAME, envName, readEnv, readSapCredentials } from "../config.js";
import { errorMessage } from "../errors.js";
import { mintDashboardsCredential } from "../saml-toggle.js";

import { cloudLoggingExecutor } from "./cloud-logging-executor.js";
import type { CredentialOpts, TargetOpts } from "./commandTypes.js";
import { printNotice } from "./output.js";

/** `CF_OTEL_CREDENTIAL_CACHE=0` (or `false`/`off`/`no`) opts out of both reading and writing the on-disk dashboards-credential cache. Anything else, including unset, leaves the cache on. */
function credentialCacheEnabled(): boolean {
  const raw = process.env["CF_OTEL_CREDENTIAL_CACHE"];
  return raw === undefined || !/^(?:0|false|off|no)$/i.test(raw);
}

function cacheKeyFor(target: ResolvedTarget, serviceInstance: string | undefined): CredentialCacheKey {
  return { target, ...(serviceInstance === undefined ? {} : { instanceSelector: serviceInstance }) };
}

/**
 * `--service-key`/`--fallback-binding-app` pin which bindings may be used, and
 * a cached credential has to honour that too: one discovered from a binding
 * the caller did not name is a miss, not a hit, however valid it still is.
 */
function pinsAllow(source: string, opts: CredentialOpts): boolean {
  if (opts.serviceKey.length === 0 && opts.fallbackBindingApp.length === 0) {
    return true;
  }
  const separator = source.indexOf(":");
  const kind = separator === -1 ? source : source.slice(0, separator);
  const label = separator === -1 ? "" : source.slice(separator + 1);
  // Each pin restricts only its own candidate type, exactly as
  // `applyNameFilters` treats them during discovery: an empty list there means
  // "no restriction on this type", not "reject this type". Reading it the other
  // way meant `--fallback-binding-app x` alone rejected every cached
  // service-key credential (and vice versa), so those runs paid the full
  // rediscovery every single time while the cache sat there valid.
  if (kind === "service-key") {
    return opts.serviceKey.length === 0 || opts.serviceKey.includes(label);
  }
  if (kind === "binding") {
    return opts.fallbackBindingApp.length === 0 || opts.fallbackBindingApp.includes(label);
  }
  // A minted credential is the product of a run these pins were given to —
  // discovery honoured them before minting — so rejecting it sent
  // `--allow-mint-credential` back through minting on every invocation, and
  // each mint disables SAML on the shared instance to do its work.
  //
  // Gated on the flag rather than accepted outright: minting is opt-in because
  // it is disruptive, and a run that did not opt in should not silently inherit
  // the result of one that did. Reusing it is harmless in itself, but the flag
  // is the only record that anyone consented to this credential existing.
  return kind === "minted" && opts.allowMintCredential;
}

/**
 * `@saptools/core`'s shared `createOpenSearchClient` normalizes/clamps
 * whatever `timeoutMs` it is given (defaulting when absent, invalid, or
 * non-positive) but — unlike cf-otel's own pre-migration local
 * `opensearch-client.ts` — does not read any environment variable itself:
 * only the caller knows its own env var name. `CF_OTEL_HTTP_TIMEOUT_MS` must
 * therefore be read and passed through here, or it silently stops working.
 */
function timeoutMsFromEnv(): number | undefined {
  const raw = readEnv(envName("HTTP_TIMEOUT_MS"));
  return raw === undefined ? undefined : Number(raw);
}

function clientFor(credential: DashboardsCredential): OpenSearchClient {
  const timeoutMs = timeoutMsFromEnv();
  return createOpenSearchClient({
    dashboardsEndpoint: credential.dashboardsEndpoint,
    username: credential.username,
    password: credential.password,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function normalizeEndpoint(apiEndpoint: string): string {
  return apiEndpoint.trim().toLowerCase().replace(/\/+$/, "");
}

async function ambientSessionMatches(target: ResolvedTarget): Promise<boolean> {
  const current = await cloudLoggingExecutor.readCurrentCfTarget();
  return (
    current !== undefined &&
    normalizeEndpoint(current.apiEndpoint) === normalizeEndpoint(target.apiEndpoint) &&
    current.orgName === target.org &&
    current.spaceName === target.space
  );
}

/**
 * Whether `error` is specifically the shared discovery's terminal "tried every
 * binding, nothing worked" failure — the exact, and only, condition under
 * which the pre-migration local `discoverDashboardsCredential` used to reach
 * its own mint branch. Anything else (a `cf curl` failure listing bindings, a
 * bad `cf api`/`cf auth`/`cf target` during an isolated login, an auth
 * rejection mid-probe) must still propagate as a real error — minting is
 * disruptive (it disables SAML on a shared instance), and must never fire as
 * a side effect of an unrelated, possibly transient failure.
 */
export function isCleanDiscoveryMiss(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Could not resolve Cloud Logging dashboards credentials for instance");
}

async function resolveInstanceNameForMint(
  target: ResolvedTarget,
  serviceInstance: string | undefined,
  ctx: CoreCfExecContext,
): Promise<string> {
  if (serviceInstance !== undefined) {
    return serviceInstance;
  }
  const instance = await discoverServiceInstance({ space: target.space }, { ...cloudLoggingExecutor, ambientContext: ctx });
  return instance.name;
}

/**
 * `@saptools/core`'s shared `discoverDashboardsCredential` deliberately does
 * not implement minting (see its own doc comment on `discoverWithSession`) —
 * cf-otel's own `saml-toggle.ts` still owns that disruptive path. When
 * ordinary discovery finds nothing usable and `--allow-mint-credential` was
 * passed, this redoes the same ambient-vs-isolated-session decision discovery
 * itself just made (deterministic from the current `cf target` alone) and
 * mints a fresh service key in that same kind of session — mirroring exactly
 * what this package's own (now-shared) discovery used to do inline. Like the
 * shared discovery's own `tryAmbientSession`, a `cf target` descriptor match
 * whose token turns out to be dead falls through to the isolated
 * SAP-credentials login rather than failing outright — see the ambient
 * branch's own comment for why this matters specifically here.
 *
 * One deliberate, narrow behavior difference from before the migration: the
 * `--verbose` trace no longer includes the "no existing key or fallback
 * binding worked" line from inside the shared discovery attempt (that detail
 * is now internal to `@saptools/core`) — the resolved credential, the
 * instance minted against, and the CLI's exit behavior are all unchanged.
 */
async function mintAsLastResort(
  target: ResolvedTarget,
  opts: CredentialOpts,
  report: (message: string) => void,
): Promise<DashboardsCredential> {
  if (await ambientSessionMatches(target)) {
    report(`reusing the current 'cf target' session for ${target.org}/${target.space} to mint a credential`);
    try {
      const ctx = cloudLoggingExecutor.ambientContext;
      const instanceName = await resolveInstanceNameForMint(target, opts.serviceInstance, ctx);
      return await mintDashboardsCredential(instanceName, ctx as unknown as CfExecContext, { confirmDisruptive: true, report });
    } catch (error) {
      // `ambientSessionMatches` only compares the `cf target` *descriptor*
      // (endpoint/org/space) — it says nothing about whether the session's
      // token is actually still valid. The shared discovery's own
      // `tryAmbientSession` already tolerates exactly this (a descriptor
      // match whose token has expired) by falling back to an isolated login;
      // mirroring that here matters because *this* function only runs after
      // discovery has already run once — if discovery itself hit this same
      // dead ambient token and fell through to an isolated SAP-credentials
      // login to reach its "clean miss", that isolated login just proved it
      // works, while the ambient session's token is the one actually broken.
      // Retrying the ambient session here regardless would mint against a
      // session already known to be unusable instead of the one just proven
      // to work.
      if (!cloudLoggingExecutor.isCfAuthFailure(error)) {
        throw error;
      }
      report(`the current 'cf target' session was rejected while minting (${errorMessage(error)}); falling back to an isolated login`);
    }
  }
  const sap = readSapCredentials();
  if (sap === undefined) {
    throw new Error(
      `Cannot reach Cloud Foundry for ${target.region}/${target.org}/${target.space} to mint a credential: no ` +
        "matching 'cf target' session is active, and SAP_EMAIL/SAP_PASSWORD are not set. Either run `cf login` " +
        `and \`cf target -o ${target.org} -s ${target.space}\`, or set SAP_EMAIL and SAP_PASSWORD.`,
    );
  }
  report(`logging in to ${target.apiEndpoint} in an isolated CF_HOME to mint a credential`);
  return await cloudLoggingExecutor.withCfSession(async (ctx) => {
    await cloudLoggingExecutor.cfApi(target.apiEndpoint, ctx);
    await cloudLoggingExecutor.cfAuth(sap.email, sap.password, ctx);
    await cloudLoggingExecutor.cfTargetSpace(target.org, target.space, ctx);
    const instanceName = await resolveInstanceNameForMint(target, opts.serviceInstance, ctx);
    return await mintDashboardsCredential(instanceName, ctx as unknown as CfExecContext, { confirmDisruptive: true, report });
  });
}

/**
 * Every subcommand does the full target -> credential -> client dance itself;
 * there is no separate "login" step to run first.
 *
 * The credential is the expensive part (a full Cloud Foundry round trip), so a
 * previously discovered one is reused from the on-disk cache when there is
 * one — silently, the way `gh` or `gcloud` reuse theirs — and discovery only
 * runs on a miss, or after OpenSearch rejects the cached credential (HTTP
 * 401/403), in which case the stale entry is dropped and the command is
 * retried once with a freshly discovered one.
 */
export async function withOpenSearchClient<T>(
  opts: TargetOpts & CredentialOpts,
  work: (client: OpenSearchClient) => Promise<T>,
): Promise<T> {
  const target = await resolveTarget(opts, cloudLoggingExecutor);
  printResolvedTarget(target, CLI_NAME);

  const cacheEnabled = credentialCacheEnabled();
  const cacheOptions = { cliName: CLI_NAME };
  const key = cacheKeyFor(target, opts.serviceInstance);

  if (cacheEnabled) {
    const cached = await readCachedCredential(key, cacheOptions);
    if (cached !== undefined && pinsAllow(cached.source, opts)) {
      if (opts.verbose) {
        printNotice(
          `[verbose] using cached dashboards credential from ${cached.source} on "${cached.instance}" ` +
            "(cached until it expires or OpenSearch rejects it; set CF_OTEL_CREDENTIAL_CACHE=0 to bypass)",
        );
      }
      try {
        return await work(clientFor(cached));
      } catch (error) {
        if (!isAuthRejection(error)) {
          throw error;
        }
        printNotice(`cached dashboards credential from ${cached.source} was rejected (${errorMessage(error)}); rediscovering`);
        await deleteCachedCredential(key, cacheOptions);
      }
    }
  }

  const report = (message: string): void => {
    if (opts.verbose) {
      printNotice(`[verbose] ${message}`);
    }
  };
  let credential: DashboardsCredential;
  try {
    credential = await discoverDashboardsCredential(
      target,
      readSapCredentials(),
      {
        ...(opts.serviceInstance === undefined ? {} : { serviceInstance: opts.serviceInstance }),
        ...(opts.serviceKey.length > 0 ? { serviceKeyNames: opts.serviceKey } : {}),
        ...(opts.fallbackBindingApp.length > 0 ? { fallbackBindingApps: opts.fallbackBindingApp } : {}),
        allowMintCredential: false,
        verbose: opts.verbose,
      },
      cloudLoggingExecutor,
    );
  } catch (error) {
    if (!opts.allowMintCredential || !isCleanDiscoveryMiss(error)) {
      throw error;
    }
    credential = await mintAsLastResort(target, opts, report);
  }

  if (cacheEnabled) {
    try {
      await writeCachedCredential(key, credential, cacheOptions);
    } catch (error) {
      // The cache only saves time; a full-disk or read-only home directory
      // must not turn a command that already has its credential into a failure.
      printNotice(`could not save the dashboards credential for reuse: ${errorMessage(error)}`);
    }
  }

  return await work(clientFor(credential));
}
