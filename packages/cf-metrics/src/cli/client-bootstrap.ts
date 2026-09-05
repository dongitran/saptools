import { credentialCacheEnabled, readSapCredentials } from "../config.js";
import type { CredentialCacheKey } from "../credential-cache.js";
import {
  credentialCacheOptionsFromEnv,
  deleteCachedCredential,
  readCachedCredential,
  writeCachedCredential,
} from "../credential-cache.js";
import { discoverDashboardsCredential } from "../dashboards-credentials.js";
import { errorMessage, isAuthRejection } from "../errors.js";
import type { OpenSearchClient } from "../opensearch-client.js";
import { createOpenSearchClient } from "../opensearch-client.js";
import { printResolvedTarget, resolveTarget } from "../target.js";
import type { DashboardsCredential, ResolvedTarget } from "../types.js";

import type { CredentialOpts, TargetOpts } from "./commandTypes.js";
import { printNotice } from "./output.js";

function cacheKeyFor(target: ResolvedTarget, opts: CredentialOpts): CredentialCacheKey {
  return {
    target,
    ...(opts.serviceInstance === undefined ? {} : { instanceSelector: opts.serviceInstance }),
  };
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
  // service-key credential (and vice versa), so those runs paid the full ~30s
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

function clientFor(credential: DashboardsCredential): OpenSearchClient {
  return createOpenSearchClient({
    dashboardsEndpoint: credential.dashboardsEndpoint,
    username: credential.username,
    password: credential.password,
  });
}

/**
 * Every subcommand does the full target -> credential -> client dance itself;
 * there is no separate "login" step to run first.
 *
 * The credential is the expensive part (a full Cloud Foundry round trip,
 * measured at 30+ seconds on a real tenant), so a previously discovered one is
 * reused from the on-disk cache when there is one — silently, the way `gh` or
 * `gcloud` reuse theirs — and discovery only runs on a miss, on
 * `--refresh-credential`, or after OpenSearch rejects the cached credential
 * (HTTP 401/403), in which case the stale entry is dropped and the command is
 * retried once with a freshly discovered one.
 */
export async function withOpenSearchClient<T>(
  opts: TargetOpts & CredentialOpts,
  work: (client: OpenSearchClient) => Promise<T>,
): Promise<T> {
  const target = await resolveTarget(opts);
  printResolvedTarget(target);

  const cacheEnabled = credentialCacheEnabled();
  const cacheOptions = credentialCacheOptionsFromEnv();
  const key = cacheKeyFor(target, opts);

  if (cacheEnabled && !opts.refreshCredential) {
    const cached = await readCachedCredential(key, cacheOptions);
    if (cached !== undefined && pinsAllow(cached.source, opts)) {
      if (opts.verbose) {
        printNotice(
          `[verbose] using cached dashboards credential from ${cached.source} on "${cached.instance}" ` +
            "(pass --refresh-credential to rediscover, or `cf-metrics credential clear` to forget it)",
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

  const credential = await discoverDashboardsCredential(target, readSapCredentials(), {
    ...(opts.serviceInstance === undefined ? {} : { serviceInstance: opts.serviceInstance }),
    ...(opts.serviceKey.length > 0 ? { serviceKeyNames: opts.serviceKey } : {}),
    ...(opts.fallbackBindingApp.length > 0 ? { fallbackBindingApps: opts.fallbackBindingApp } : {}),
    allowMintCredential: opts.allowMintCredential,
    verbose: opts.verbose,
  });

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
