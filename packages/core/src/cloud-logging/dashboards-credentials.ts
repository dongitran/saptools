import { extractDashboardsCredential, parseCredentialJson } from "./dashboards-payload.js";
import { discoverServiceInstance } from "./instance-discovery.js";
import type { CloudLoggingCfExecutor, CloudLoggingInstance, DashboardsCredential, ResolvedTarget } from "./types.js";

export { discoverServiceInstance };

export interface CredentialDiscoveryOptions {
  readonly serviceInstance?: string;
  readonly serviceKeyNames?: readonly string[];
  readonly fallbackBindingApps?: readonly string[];
  readonly allowMintCredential: boolean;
  readonly verbose: boolean;
}

export interface SapCredentials {
  readonly email: string;
  readonly password: string;
}

type StepReporter = (message: string) => void;

interface BindingRef {
  readonly guid: string;
  readonly type: "key" | "app";
  readonly label: string;
  readonly createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function appGuidOf(resource: Record<string, unknown>): string | undefined {
  const relationships = resource["relationships"];
  if (!isRecord(relationships)) {return undefined;}
  const app = relationships["app"];
  const data = isRecord(app) ? app["data"] : undefined;
  return isRecord(data) ? readString(data, "guid") : undefined;
}
function includedAppNames(payload: Record<string, unknown>): ReadonlyMap<string, string> {
  const included = payload["included"];
  const apps = isRecord(included) ? included["apps"] : undefined;
  const names = new Map<string, string>();
  if (!Array.isArray(apps)) {return names;}
  for (const app of apps) {
    if (!isRecord(app)) {continue;}
    const guid = readString(app, "guid");
    const name = readString(app, "name");
    if (guid !== undefined && name !== undefined) {names.set(guid, name);}
  }
  return names;
}
function parseBindingsPage(payload: Record<string, unknown>): readonly BindingRef[] {
  const resources = payload["resources"];
  if (!Array.isArray(resources)) {return [];}
  const appNames = includedAppNames(payload);
  const bindings: BindingRef[] = [];
  for (const resource of resources) {
    if (!isRecord(resource)) {continue;}
    const guid = readString(resource, "guid");
    const type = resource["type"];
    if (guid === undefined || (type !== "key" && type !== "app")) {continue;}
    const appGuid = appGuidOf(resource);
    const label = readString(resource, "name") ?? (appGuid === undefined ? undefined : appNames.get(appGuid)) ?? guid;
    bindings.push({ guid, type, label, createdAt: readString(resource, "created_at") ?? "" });
  }
  return bindings;
}
function prioritize(bindings: readonly BindingRef[]): readonly BindingRef[] {
  return [...bindings].sort((a, b) => {
    if (a.type !== b.type) {return a.type === "key" ? -1 : 1;}
    return a.type === "key" ? b.createdAt.localeCompare(a.createdAt) : a.createdAt.localeCompare(b.createdAt);
  });
}
async function listCredentialBindings(instanceGuid: string, executor: CloudLoggingCfExecutor): Promise<readonly BindingRef[]> {
  const bindings: BindingRef[] = [];
  let page = 1;
  let hasMore = true;
  const pageSize = 100;
  const maxPages = 20;
  while (hasMore && page <= maxPages) {
    const raw = await executor.cfCurl(
      `/v3/service_credential_bindings?service_instance_guids=${encodeURIComponent(instanceGuid)}&per_page=${String(pageSize)}&page=${String(page)}&include=app`,
      executor.ambientContext,
    );
    const payload = parseCredentialJson(raw, `credential bindings page ${String(page)}`);
    if (!isRecord(payload)) {break;}
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
async function readBindingCredential(binding: BindingRef, instance: string, executor: CloudLoggingCfExecutor): Promise<DashboardsCredential | undefined> {
  const raw = await executor.cfCurl(`/v3/service_credential_bindings/${encodeURIComponent(binding.guid)}/details`, executor.ambientContext);
  const payload = parseCredentialJson(raw, `${describe(binding)} details`);
  const credentials = isRecord(payload) ? payload["credentials"] : undefined;
  const extracted = extractDashboardsCredential(credentials, sourceOf(binding));
  return extracted === undefined ? undefined : { ...extracted, instance };
}
async function resolveFromBindings(
  bindings: readonly BindingRef[],
  instance: string,
  executor: CloudLoggingCfExecutor,
  recordAttempt: (detail: string) => void,
): Promise<DashboardsCredential | undefined> {
  const concurrency = 5;
  for (let start = 0; start < bindings.length; start += concurrency) {
    const batch = bindings.slice(start, start + concurrency);
    const outcomes = await Promise.all(
      batch.map(async (binding) => {
        try {
          return { binding, credential: await readBindingCredential(binding, instance, executor) };
        } catch (error) {
          return { binding, error };
        }
      }),
    );
    for (const outcome of outcomes) {
      if ("error" in outcome) {
        if (executor.isCfAuthFailure(outcome.error)) {throw outcome.error;}
        const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        recordAttempt(`${describe(outcome.binding)}: ${message}`);
        continue;
      }
      if (outcome.credential !== undefined) {return outcome.credential;}
      recordAttempt(`${describe(outcome.binding)}: no dashboards-username/dashboards-password (created after SAML was enabled)`);
    }
  }
  return undefined;
}
function applyNameFilters(bindings: readonly BindingRef[], options: CredentialDiscoveryOptions): readonly BindingRef[] {
  const keyNames = options.serviceKeyNames;
  const appNames = options.fallbackBindingApps;
  return bindings.filter((binding) => {
    const pinned = binding.type === "key" ? keyNames : appNames;
    return pinned === undefined || pinned.includes(binding.label);
  });
}
async function resolveInstance(target: ResolvedTarget, options: CredentialDiscoveryOptions, executor: CloudLoggingCfExecutor): Promise<CloudLoggingInstance> {
  if (options.serviceInstance !== undefined) {
    return { name: options.serviceInstance, guid: await executor.cfServiceGuid(options.serviceInstance, executor.ambientContext) };
  }
  return await discoverServiceInstance(target, executor);
}
async function discoverWithSession(
  target: ResolvedTarget,
  options: CredentialDiscoveryOptions,
  executor: CloudLoggingCfExecutor,
  report: StepReporter,
): Promise<DashboardsCredential> {
  const instance = await resolveInstance(target, options, executor);
  report(`using service instance "${instance.name}"`);
  const attempts: string[] = [];
  const recordAttempt = (detail: string): void => {
    attempts.push(detail);
    report(detail);
  };
  const allBindings = await listCredentialBindings(instance.guid, executor);
  const candidates = prioritize(applyNameFilters(allBindings, options));
  report(`found ${String(allBindings.length)} credential binding(s) on "${instance.name}", ${String(candidates.length)} to try`);
  if (candidates.length === 0) {
    recordAttempt(
      allBindings.length === 0
        ? `instance "${instance.name}" has no service keys or app bindings to read credentials from`
        : `all ${String(allBindings.length)} binding(s) on "${instance.name}" were excluded by --service-key/--fallback-binding-app`,
    );
  }
  const fromBindings = await resolveFromBindings(candidates, instance.name, executor, recordAttempt);
  if (fromBindings !== undefined) {
    report(`resolved dashboards credential from ${fromBindings.source}`);
    return fromBindings;
  }
  if (options.allowMintCredential) {
    throw new Error(
      "Minting (--allow-mint-credential) is not implemented in the shared core module; each consumer's own saml-toggle.ts still owns this disruptive path and must call it directly on a discoverWithSession miss.",
    );
  }
  const attemptsText = attempts.map((detail) => `  - ${detail}`).join("\n");
  throw new Error(
    `Could not resolve Cloud Logging dashboards credentials for instance "${instance.name}". Tried:\n${attemptsText}\nPass --allow-mint-credential to temporarily disable SAML and mint a new key as a last resort (disruptive: breaks SSO dashboards login for all users during the window).`,
  );
}
function normalizeEndpoint(apiEndpoint: string): string {
  const trimmed = apiEndpoint.trim().toLowerCase();
  let end = trimmed.length;
  while (end > 0 && trimmed[end - 1] === "/") {end--;}
  return trimmed.slice(0, end);
}
function sameTarget(current: { readonly apiEndpoint: string; readonly orgName: string; readonly spaceName: string } | undefined, target: ResolvedTarget): boolean {
  return current !== undefined && normalizeEndpoint(current.apiEndpoint) === normalizeEndpoint(target.apiEndpoint) && current.orgName === target.org && current.spaceName === target.space;
}
type AmbientOutcome = { readonly ok: true; readonly credential: DashboardsCredential } | { readonly ok: false; readonly reason: string };
async function tryAmbientSession(target: ResolvedTarget, options: CredentialDiscoveryOptions, executor: CloudLoggingCfExecutor, report: StepReporter): Promise<AmbientOutcome> {
  const current = await executor.readCurrentCfTarget();
  if (!sameTarget(current, target)) {
    return { ok: false, reason: current === undefined ? "no 'cf target' session is active" : `the current 'cf target' session points at ${current.orgName}/${current.spaceName} on ${current.apiEndpoint}` };
  }
  report(`reusing the current 'cf target' session for ${target.org}/${target.space} (no isolated login)`);
  let credential: DashboardsCredential;
  try {
    credential = await discoverWithSession(target, options, executor, report);
  } catch (error) {
    if (!executor.isCfAuthFailure(error)) {throw error;}
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `the current 'cf' session was rejected (${message})` };
  }
  if (!sameTarget(await executor.readCurrentCfTarget(), target)) {
    throw new Error(`The 'cf target' session changed while discovery was reading it, so the credential it returned cannot be trusted to belong to ${target.region}/${target.org}/${target.space}. Retry, or pin --region/--org/--space.`);
  }
  return { ok: true, credential };
}

/**
 * Resolve a working OpenSearch dashboards basic-auth credential: through the
 * caller's own matching `cf` session when there is one, otherwise through an
 * isolated login using `sap` (required only on that path). Ported from
 * `@saptools/cf-metrics`'s `discoverDashboardsCredential` — the shape both
 * `@saptools/cf-otel` and `@saptools/cf-log-search` adopt.
 */
export async function discoverDashboardsCredential(
  target: ResolvedTarget,
  sap: SapCredentials | undefined,
  options: CredentialDiscoveryOptions,
  executor: CloudLoggingCfExecutor,
): Promise<DashboardsCredential> {
  const report: StepReporter = (message) => {
    if (options.verbose) {process.stderr.write(`[verbose] ${message}\n`);}
  };
  const ambient = await tryAmbientSession(target, options, executor, report);
  if (ambient.ok) {return ambient.credential;}
  if (sap === undefined) {
    throw new Error(
      `Cannot reach Cloud Foundry for ${target.region}/${target.org}/${target.space}: ${ambient.reason}, and SAP_EMAIL/SAP_PASSWORD are not set. Either run \`cf login\` and \`cf target -o ${target.org} -s ${target.space}\` (a matching session is reused as-is), or set SAP_EMAIL and SAP_PASSWORD to log in automatically.`,
    );
  }
  report(`${ambient.reason}; logging in to ${target.apiEndpoint} in an isolated CF_HOME`);
  return await executor.withCfSession(async (ctx) => {
    await executor.cfApi(target.apiEndpoint, ctx);
    await executor.cfAuth(sap.email, sap.password, ctx);
    await executor.cfTargetSpace(target.org, target.space, ctx);
    return await discoverWithSession(target, options, { ...executor, ambientContext: ctx }, report);
  });
}
