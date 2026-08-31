import { isRecord } from "./agg-buckets.js";
import type { CfExecContext } from "./cf.js";
import { cfApi, cfAuth, cfCurl, cfServiceGuid, cfTargetSpace, withCfSession } from "./cf.js";
import {
  BINDING_PROBE_CONCURRENCY,
  BINDINGS_PAGE_SIZE,
  CLI_NAME,
  MAX_BINDING_PAGES,
  type SapCredentials,
} from "./config.js";
import { extractDashboardsCredential, parseCredentialJson } from "./dashboards-payload.js";
import { CredentialsNotFoundError, errorMessage } from "./errors.js";
import { mintDashboardsCredential } from "./saml-toggle.js";
import { discoverServiceInstance } from "./service-discovery.js";
import type { DashboardsCredential, ResolvedTarget } from "./types.js";

export interface CredentialDiscoveryOptions {
  readonly serviceInstance?: string;
  readonly serviceKeyNames?: readonly string[];
  readonly fallbackBindingApps?: readonly string[];
  readonly allowMintCredential: boolean;
  readonly verbose: boolean;
}

/** One credential binding on the instance, flattened from the v3 API response. */
interface BindingRef {
  readonly guid: string;
  readonly type: "key" | "app";
  /** Service-key name, or the bound app's name — for reporting and for `--service-key`/`--fallback-binding-app` filtering. */
  readonly label: string;
  readonly createdAt: string;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function appGuidOf(resource: Record<string, unknown>): string | undefined {
  const relationships = resource["relationships"];
  if (!isRecord(relationships)) {
    return undefined;
  }
  const app = relationships["app"];
  const data = isRecord(app) ? app["data"] : undefined;
  return isRecord(data) ? readString(data, "guid") : undefined;
}

/** App GUID -> name, from the `include=app` sidecar, so app bindings can be named without extra requests. */
function includedAppNames(payload: Record<string, unknown>): ReadonlyMap<string, string> {
  const included = payload["included"];
  const apps = isRecord(included) ? included["apps"] : undefined;
  const names = new Map<string, string>();
  if (!Array.isArray(apps)) {
    return names;
  }
  for (const app of apps) {
    if (!isRecord(app)) {
      continue;
    }
    const guid = readString(app, "guid");
    const name = readString(app, "name");
    if (guid !== undefined && name !== undefined) {
      names.set(guid, name);
    }
  }
  return names;
}

function parseBindingsPage(payload: Record<string, unknown>): readonly BindingRef[] {
  const resources = payload["resources"];
  if (!Array.isArray(resources)) {
    return [];
  }
  const appNames = includedAppNames(payload);
  const bindings: BindingRef[] = [];
  for (const resource of resources) {
    if (!isRecord(resource)) {
      continue;
    }
    const guid = readString(resource, "guid");
    const type = resource["type"];
    if (guid === undefined || (type !== "key" && type !== "app")) {
      continue;
    }
    const appGuid = appGuidOf(resource);
    const label = readString(resource, "name") ?? (appGuid === undefined ? undefined : appNames.get(appGuid)) ?? guid;
    bindings.push({ guid, type, label, createdAt: readString(resource, "created_at") ?? "" });
  }
  return bindings;
}

/**
 * Purpose-made service keys first, then app bindings.
 *
 * Within each type the tiebreak differs, and deliberately so. Only credentials
 * created *before* SAML was switched on retain a basic-auth
 * username/password — newer ones expose the endpoint and mTLS ingest material
 * only — so for app bindings, which nobody creates by hand, age is a real
 * signal and the oldest is tried first (verified live: a binding from one
 * month carried credentials, ones from the next did not). Keys are different:
 * they are created deliberately, and one minted during an intentional
 * SAML-off window can be *newer* than a key without credentials, so age
 * predicts nothing there and the prior newest-first convention is kept.
 *
 * Ordering is only a preference, never a correctness requirement:
 * {@link resolveFromBindings} probes candidates concurrently and still returns
 * the highest-priority hit.
 */
function prioritize(bindings: readonly BindingRef[]): readonly BindingRef[] {
  return [...bindings].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "key" ? -1 : 1;
    }
    return a.type === "key" ? b.createdAt.localeCompare(a.createdAt) : a.createdAt.localeCompare(b.createdAt);
  });
}

/**
 * Every credential binding on the instance, in one v3 request per page.
 *
 * Replaces the previous "list bound apps, then `cf env` each one and search its
 * whole environment for this instance" scan, which cost one process spawn plus
 * two API round trips per app — ~15s across 59 apps on a real tenant, and
 * unpredictable because it depended on where in the list a usable binding
 * happened to sit.
 */
async function listCredentialBindings(instanceGuid: string, ctx: CfExecContext): Promise<readonly BindingRef[]> {
  const bindings: BindingRef[] = [];
  let page = 1;
  let hasMore = true;
  while (hasMore && page <= MAX_BINDING_PAGES) {
    const raw = await cfCurl(
      `/v3/service_credential_bindings?service_instance_guids=${encodeURIComponent(instanceGuid)}` +
        `&per_page=${String(BINDINGS_PAGE_SIZE)}&page=${String(page)}&include=app`,
      ctx,
    );
    const payload = parseCredentialJson(raw, `credential bindings page ${String(page)}`);
    if (!isRecord(payload)) {
      break;
    }
    bindings.push(...parseBindingsPage(payload));
    const pagination = payload["pagination"];
    const reported = isRecord(pagination) ? pagination["total_pages"] : undefined;
    hasMore = page < (typeof reported === "number" && reported > 0 ? reported : 1);
    page += 1;
  }
  return bindings;
}

function describe(binding: BindingRef): string {
  return binding.type === "key" ? `service key "${binding.label}"` : `app binding "${binding.label}"`;
}

function sourceOf(binding: BindingRef): string {
  return binding.type === "key" ? `service-key:${binding.label}` : `binding:${binding.label}`;
}

async function readBindingCredential(binding: BindingRef, ctx: CfExecContext): Promise<DashboardsCredential | undefined> {
  const raw = await cfCurl(`/v3/service_credential_bindings/${encodeURIComponent(binding.guid)}/details`, ctx);
  const payload = parseCredentialJson(raw, `${describe(binding)} details`);
  const credentials = isRecord(payload) ? payload["credentials"] : undefined;
  return extractDashboardsCredential(credentials, sourceOf(binding));
}

/**
 * Probe candidates in {@link prioritize} order, a bounded batch at a time, and
 * return the first hit *by priority* rather than the first to respond — so the
 * chosen credential never depends on network timing.
 */
async function resolveFromBindings(
  bindings: readonly BindingRef[],
  ctx: CfExecContext,
  recordAttempt: (detail: string) => void,
): Promise<DashboardsCredential | undefined> {
  for (let start = 0; start < bindings.length; start += BINDING_PROBE_CONCURRENCY) {
    const batch = bindings.slice(start, start + BINDING_PROBE_CONCURRENCY);
    const outcomes = await Promise.all(
      batch.map(async (binding) => {
        try {
          return { binding, credential: await readBindingCredential(binding, ctx) };
        } catch (error) {
          return { binding, error };
        }
      }),
    );
    for (const outcome of outcomes) {
      if ("error" in outcome) {
        recordAttempt(`${describe(outcome.binding)}: ${errorMessage(outcome.error)}`);
        continue;
      }
      if (outcome.credential !== undefined) {
        return outcome.credential;
      }
      recordAttempt(
        `${describe(outcome.binding)}: no dashboards-username/dashboards-password ` +
          "(created after SAML was enabled)",
      );
    }
  }
  return undefined;
}

/** Keep only the candidates the caller pinned by name, when they pinned any. */
function applyNameFilters(
  bindings: readonly BindingRef[],
  options: CredentialDiscoveryOptions,
): readonly BindingRef[] {
  const keyNames = options.serviceKeyNames;
  const appNames = options.fallbackBindingApps;
  return bindings.filter((binding) => {
    const pinned = binding.type === "key" ? keyNames : appNames;
    return pinned === undefined || pinned.includes(binding.label);
  });
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

    const instanceGuid = await cfServiceGuid(instance, ctx);
    const allBindings = await listCredentialBindings(instanceGuid, ctx);
    const candidates = prioritize(applyNameFilters(allBindings, options));
    report(`found ${String(allBindings.length)} credential binding(s) on "${instance}", ${String(candidates.length)} to try`);

    if (candidates.length === 0) {
      // Distinguish "nothing is bound" from "your filters excluded everything" —
      // conflating them sends the reader looking for the wrong problem.
      recordAttempt(
        allBindings.length === 0
          ? `instance "${instance}" has no service keys or app bindings to read credentials from`
          : `all ${String(allBindings.length)} binding(s) on "${instance}" were excluded by --service-key/--fallback-binding-app`,
      );
    }
    const fromBindings = await resolveFromBindings(candidates, ctx, recordAttempt);
    if (fromBindings !== undefined) {
      report(`resolved dashboards credential from ${fromBindings.source}`);
      return fromBindings;
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
