import type { CfExecContext } from "./cf.js";
import {
  cfApi,
  cfAuth,
  cfEnv,
  cfServiceKey,
  cfServiceKeys,
  cfTargetSpace,
  extractVcapServices,
  parseServiceKeyNames,
  withCfSession,
} from "./cf.js";
import { CLI_NAME, type SapCredentials } from "./config.js";
import { extractDashboardsCredential, parseCredentialJson } from "./dashboards-payload.js";
import { CredentialsNotFoundError, errorMessage } from "./errors.js";
import { mintDashboardsCredential } from "./saml-toggle.js";
import { discoverServiceInstance, findBoundApps } from "./service-discovery.js";
import type { DashboardsCredential, ResolvedTarget } from "./types.js";

export interface CredentialDiscoveryOptions {
  readonly serviceInstance?: string;
  readonly serviceKeyNames?: readonly string[];
  readonly fallbackBindingApps?: readonly string[];
  readonly allowMintCredential: boolean;
  readonly verbose: boolean;
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A VCAP_SERVICES entry's `name` is the *binding* name, which only equals
 * the real service instance name when no custom `--binding-name` was used;
 * `instance_name`, when present, is the authoritative instance name and
 * must be preferred (confirmed against this exact distinction already
 * handled the same way by a sibling package, `cf-event-mesh`, elsewhere in
 * this monorepo). Matching on `name` alone would silently miss a real,
 * usable credential on any binding created with a custom name.
 */
function vcapEntryMatchesInstance(record: Record<string, unknown>, instanceName: string): boolean {
  const boundInstanceName = readNonEmptyString(record, "instance_name") ?? readNonEmptyString(record, "name");
  return boundInstanceName === instanceName;
}

function findDashboardsCredentialInVcap(
  vcap: Record<string, unknown>,
  instanceName: string,
  appName: string,
): DashboardsCredential | undefined {
  for (const entries of Object.values(vcap)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (!vcapEntryMatchesInstance(record, instanceName)) {
        continue;
      }
      const credential = extractDashboardsCredential(record["credentials"], `fallback-binding:${appName}`);
      if (credential !== undefined) {
        return credential;
      }
    }
  }
  return undefined;
}

/**
 * `cf service-keys` does not expose creation timestamps (see
 * {@link parseServiceKeyNames}); reversing the platform's listing order is a
 * best-effort proxy for "newest first", not a verified guarantee.
 */
async function newestFirstKeyNames(instance: string, ctx: CfExecContext): Promise<readonly string[]> {
  return [...parseServiceKeyNames(await cfServiceKeys(instance, ctx))].reverse();
}

async function tryServiceKeys(
  instance: string,
  keyNames: readonly string[],
  ctx: CfExecContext,
  recordAttempt: (detail: string) => void,
): Promise<DashboardsCredential | undefined> {
  for (const keyName of keyNames) {
    try {
      const payload = parseCredentialJson(await cfServiceKey(instance, keyName, ctx), `service key "${keyName}" payload`);
      const credential = extractDashboardsCredential(payload, `service-key:${keyName}`);
      if (credential !== undefined) {
        return credential;
      }
      recordAttempt(`service key "${keyName}": payload had no dashboards-username/dashboards-password`);
    } catch (error) {
      recordAttempt(`service key "${keyName}": ${errorMessage(error)}`);
    }
  }
  if (keyNames.length === 0) {
    recordAttempt(`no service keys exist on instance "${instance}"`);
  }
  return undefined;
}

async function tryFallbackBindings(
  instance: string,
  apps: readonly string[],
  ctx: CfExecContext,
  recordAttempt: (detail: string) => void,
): Promise<DashboardsCredential | undefined> {
  for (const app of apps) {
    try {
      const vcap = extractVcapServices(await cfEnv(app, ctx));
      const credential = findDashboardsCredentialInVcap(vcap, instance, app);
      if (credential !== undefined) {
        return credential;
      }
      recordAttempt(
        `fallback binding app "${app}": bound entry had no dashboards-username/dashboards-password ` +
          "(likely bound after SAML was enabled)",
      );
    } catch (error) {
      recordAttempt(`fallback binding app "${app}": ${errorMessage(error)}`);
    }
  }
  if (apps.length === 0) {
    recordAttempt(`no apps are bound to instance "${instance}"`);
  }
  return undefined;
}

/**
 * Resolve a working OpenSearch dashboards basic-auth credential following the
 * documented decision tree: existing service keys, then fallback bindings
 * that predate SAML being enabled, then (only behind an explicit opt-in) a
 * temporary SAML disable/restore. Every step is reported via `report` when
 * `--verbose` is set, and the resolved credential lives only in the returned
 * object — nothing secret is cached or written to disk.
 */
export async function discoverDashboardsCredential(
  target: ResolvedTarget,
  sap: SapCredentials,
  options: CredentialDiscoveryOptions,
): Promise<DashboardsCredential> {
  return await withCfSession(async (ctx) => {
    const report = (message: string): void => {
      if (options.verbose) {
        process.stderr.write(`${CLI_NAME}: [verbose] ${message}\n`);
      }
    };

    await cfApi(target.apiEndpoint, ctx);
    await cfAuth(sap.email, sap.password, ctx);
    await cfTargetSpace(target.org, target.space, ctx);

    const instance = options.serviceInstance ?? (await discoverServiceInstance(ctx));
    report(`using service instance "${instance}"`);

    const attempts: string[] = [];
    const recordAttempt = (detail: string): void => {
      attempts.push(detail);
      report(detail);
    };

    const keyNames = options.serviceKeyNames ?? (await newestFirstKeyNames(instance, ctx));
    const fromKeys = await tryServiceKeys(instance, keyNames, ctx, recordAttempt);
    if (fromKeys !== undefined) {
      report(`resolved dashboards credential from ${fromKeys.source}`);
      return fromKeys;
    }

    const fallbackApps = options.fallbackBindingApps ?? (await findBoundApps(instance, ctx));
    const fromFallback = await tryFallbackBindings(instance, fallbackApps, ctx, recordAttempt);
    if (fromFallback !== undefined) {
      report(`resolved dashboards credential from ${fromFallback.source}`);
      return fromFallback;
    }

    if (options.allowMintCredential) {
      report(
        "no existing key or fallback binding worked; minting a new credential via --allow-mint-credential",
      );
      return await mintDashboardsCredential(instance, ctx, { confirmDisruptive: true, report });
    }

    const attemptsText = attempts.map((detail) => `  - ${detail}`).join("\n");
    throw new CredentialsNotFoundError(
      `Could not resolve Cloud Logging dashboards credentials for instance "${instance}". Tried:\n${attemptsText}\nPass --allow-mint-credential to temporarily disable SAML and mint a new key as a last resort (disruptive: breaks SSO dashboards login for all users during the window).`,
    );
  });
}
