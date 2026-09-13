import type { CredentialCacheKey, DashboardsCredential, OpenSearchClient, ResolvedTarget } from "@saptools/core";
import {
  createOpenSearchClient,
  deleteCachedCredential,
  discoverDashboardsCredential,
  isAuthRejection,
  printResolvedTarget,
  readCachedCredential,
  resolveTarget,
  writeCachedCredential,
} from "@saptools/core";

import { CLI_NAME, credentialCacheEnabled, readSapCredentials, saptoolsRootFromEnv } from "../config.js";
import { errorMessage } from "../errors.js";

import { cloudLoggingExecutor } from "./cloud-logging-executor.js";
import type { CredentialOpts, TargetOpts } from "./commandTypes.js";
import { printNotice } from "./output.js";

function cacheOptionsFromEnv(): { readonly cliName: string; readonly saptoolsRoot?: string } {
  const root = saptoolsRootFromEnv();
  return { cliName: CLI_NAME, ...(root === undefined ? {} : { saptoolsRoot: root }) };
}

function cacheKeyFor(target: ResolvedTarget, opts: CredentialOpts): CredentialCacheKey {
  return { target, ...(opts.serviceInstance === undefined ? {} : { instanceSelector: opts.serviceInstance }) };
}

function pinsAllow(source: string, opts: CredentialOpts): boolean {
  if (opts.serviceKey.length === 0 && opts.fallbackBindingApp.length === 0) {
    return true;
  }
  const separator = source.indexOf(":");
  const kind = separator === -1 ? source : source.slice(0, separator);
  const label = separator === -1 ? "" : source.slice(separator + 1);
  if (kind === "service-key") {
    return opts.serviceKey.length === 0 || opts.serviceKey.includes(label);
  }
  if (kind === "binding") {
    return opts.fallbackBindingApp.length === 0 || opts.fallbackBindingApp.includes(label);
  }
  return false;
}

function clientFor(credential: DashboardsCredential): OpenSearchClient {
  return createOpenSearchClient({ dashboardsEndpoint: credential.dashboardsEndpoint, username: credential.username, password: credential.password });
}

/**
 * `@saptools/core`'s shared credentials-not-found message names
 * `--allow-mint-credential` as a last resort, worded identically for every
 * consumer of `discoverDashboardsCredential`. This package does not expose
 * that flag (see the Global Constraints note and `shared-options.ts`) — the
 * one line naming it is rewritten here rather than forking the shared
 * message text, so a future wording change upstream stays in sync
 * automatically everywhere except this one substitution.
 */
function withoutMintCredentialMention(message: string): string {
  return message.replace(
    /\s*Pass --allow-mint-credential to temporarily disable SAML and mint a new key as a last resort \(disruptive: breaks SSO dashboards login for all users during the window\)\.?/,
    "",
  );
}

/**
 * Every command resolves target -> credential -> client itself; there is no
 * separate login step. A previously discovered credential is reused from the
 * on-disk cache (via `@saptools/core`, scoped by `cliName: "cf-log-search"`)
 * until it expires or OpenSearch rejects it (HTTP 401/403), in which case the
 * stale entry is dropped and the command is retried once with a freshly
 * discovered one.
 */
export async function withOpenSearchClient<T>(opts: TargetOpts & CredentialOpts, work: (client: OpenSearchClient) => Promise<T>): Promise<T> {
  const target = await resolveTarget(opts, cloudLoggingExecutor);
  printResolvedTarget(target, CLI_NAME);

  const cacheEnabled = credentialCacheEnabled();
  const cacheOptions = cacheOptionsFromEnv();
  const key = cacheKeyFor(target, opts);

  async function discoverFresh(): Promise<DashboardsCredential> {
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
      if (error instanceof Error) {
        error.message = withoutMintCredentialMention(error.message);
      }
      throw error;
    }
    if (cacheEnabled) {
      try {
        await writeCachedCredential(key, credential, cacheOptions);
      } catch (error) {
        printNotice(`could not save the dashboards credential for reuse: ${errorMessage(error)}`);
      }
    }
    return credential;
  }

  let credential: DashboardsCredential | undefined;
  if (cacheEnabled && !opts.refreshCredential) {
    const cached = await readCachedCredential(key, cacheOptions);
    if (cached !== undefined && pinsAllow(cached.source, opts)) {
      if (opts.verbose) {
        printNotice(`[verbose] using cached dashboards credential from ${cached.source} on "${cached.instance}" (pass --refresh-credential to rediscover, or \`cf-log-search credential clear\` to forget it)`);
      }
      credential = cached;
    }
  }
  credential ??= await discoverFresh();

  try {
    return await work(clientFor(credential));
  } catch (error) {
    if (!isAuthRejection(error)) {
      throw error;
    }
    printNotice(`dashboards credential from ${credential.source} was rejected (${errorMessage(error)}); rediscovering`);
    if (cacheEnabled) {
      await deleteCachedCredential(key, cacheOptions);
    }
    const fresh = await discoverFresh();
    return await work(clientFor(fresh));
  }
}
