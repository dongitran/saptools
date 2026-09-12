import type { CloudLoggingCfExecutor, CloudLoggingInstance } from "./types.js";

const CLOUD_LOGGING_OFFERING = "cloud-logging";
const INSTANCES_PAGE_SIZE = 200;
const MAX_INSTANCE_PAGES = 20;
const INSTANCE_LISTING_FIELDS =
  `&${encodeURIComponent("fields[service_plan]")}=guid,name,relationships.service_offering` +
  `&${encodeURIComponent("fields[service_plan.service_offering]")}=guid,name`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function relationshipGuid(resource: Record<string, unknown>, relationship: string): string | undefined {
  const relationships = resource["relationships"];
  const entry = isRecord(relationships) ? relationships[relationship] : undefined;
  const data = isRecord(entry) ? entry["data"] : undefined;
  return isRecord(data) ? readString(data, "guid") : undefined;
}

function recordsOf(payload: Record<string, unknown>, ...path: readonly string[]): readonly Record<string, unknown>[] {
  let cursor: unknown = payload;
  for (const key of path) {
    cursor = isRecord(cursor) ? cursor[key] : undefined;
  }
  return Array.isArray(cursor) ? cursor.filter(isRecord) : [];
}

function offeringNamesByPlanGuid(payload: Record<string, unknown>): ReadonlyMap<string, string> {
  const offeringNames = new Map<string, string>();
  for (const offering of recordsOf(payload, "included", "service_offerings")) {
    const guid = readString(offering, "guid");
    const name = readString(offering, "name");
    if (guid !== undefined && name !== undefined) {
      offeringNames.set(guid, name);
    }
  }
  const byPlan = new Map<string, string>();
  for (const plan of recordsOf(payload, "included", "service_plans")) {
    const guid = readString(plan, "guid");
    const offeringGuid = relationshipGuid(plan, "service_offering");
    const offeringName = offeringGuid === undefined ? undefined : offeringNames.get(offeringGuid);
    if (guid !== undefined && offeringName !== undefined) {
      byPlan.set(guid, offeringName);
    }
  }
  return byPlan;
}

interface ManagedInstance extends CloudLoggingInstance {
  readonly offering: string | undefined;
}

function parseInstancesPage(payload: Record<string, unknown>): readonly ManagedInstance[] {
  const offeringByPlan = offeringNamesByPlanGuid(payload);
  const instances: ManagedInstance[] = [];
  for (const resource of recordsOf(payload, "resources")) {
    const name = readString(resource, "name");
    const guid = readString(resource, "guid");
    if (name === undefined || guid === undefined) {
      continue;
    }
    const planGuid = relationshipGuid(resource, "service_plan");
    instances.push({ name, guid, offering: planGuid === undefined ? undefined : offeringByPlan.get(planGuid) });
  }
  return instances;
}

function parseListing(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("cf curl /v3/service_instances returned an unexpected shape.");
  }
  return parsed;
}

/** Every Cloud Logging service instance in the target's space, via the v3 API. */
export async function listCloudLoggingInstances(
  target: { readonly space: string },
  executor: CloudLoggingCfExecutor,
): Promise<readonly CloudLoggingInstance[]> {
  const spaceGuid = await executor.cfSpaceGuid(target.space, executor.ambientContext);
  const instances: ManagedInstance[] = [];
  let page = 1;
  let hasMore = true;
  while (hasMore && page <= MAX_INSTANCE_PAGES) {
    const raw = await executor.cfCurl(
      `/v3/service_instances?space_guids=${encodeURIComponent(spaceGuid)}&type=managed&per_page=${String(INSTANCES_PAGE_SIZE)}&page=${String(page)}${INSTANCE_LISTING_FIELDS}`,
      executor.ambientContext,
    );
    const payload = parseListing(raw);
    instances.push(...parseInstancesPage(payload));
    const pagination = payload["pagination"];
    const reported = isRecord(pagination) ? pagination["total_pages"] : undefined;
    hasMore = page < (typeof reported === "number" && reported > 0 ? reported : 1);
    page += 1;
  }
  return instances.filter((instance) => instance.offering?.toLowerCase() === CLOUD_LOGGING_OFFERING).map(({ name, guid }) => ({ name, guid }));
}

/** Auto-discover the single Cloud Logging instance in the space, failing closed on 0 or many. */
export async function discoverServiceInstance(
  target: { readonly space: string },
  executor: CloudLoggingCfExecutor,
): Promise<CloudLoggingInstance> {
  const instances = await listCloudLoggingInstances(target, executor);
  if (instances.length > 1) {
    const names = instances.map((instance) => instance.name).join(", ");
    throw new Error(`Multiple "${CLOUD_LOGGING_OFFERING}" service instances found in this space (${names}); pass --service-instance to pick one.`);
  }
  const [only] = instances;
  if (only === undefined) {
    throw new Error(`No "${CLOUD_LOGGING_OFFERING}" service instance found in this space. Pass --service-instance to name one explicitly.`);
  }
  return only;
}
