import { isRecord } from "./agg-buckets.js";
import type { CfExecContext } from "./cf.js";
import { cfCurl, cfSpaceGuid, extractFirstJsonObject } from "./cf.js";
import { INSTANCES_PAGE_SIZE, MAX_INSTANCE_PAGES } from "./config.js";
import { CfMetricsError } from "./errors.js";

const CLOUD_LOGGING_OFFERING = "cloud-logging";

/**
 * The two `fields[...]` sidecars that let one listing answer "which offering
 * is this instance from": an instance references only its plan, and a plan
 * only its offering. Built with `encodeURIComponent` because the brackets
 * must travel percent-encoded through `cf curl`.
 */
const INSTANCE_LISTING_FIELDS =
  `&${encodeURIComponent("fields[service_plan]")}=guid,name,relationships.service_offering` +
  `&${encodeURIComponent("fields[service_plan.service_offering]")}=guid,name`;

/** One Cloud Logging service instance, with the GUID the v3 API addresses it by. */
export interface CloudLoggingInstance {
  readonly name: string;
  readonly guid: string;
}

interface ManagedInstance extends CloudLoggingInstance {
  readonly offering: string | undefined;
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

/**
 * Plan GUID -> offering name, from the `fields[...]` sidecars the listing was
 * asked for. Two hops because an instance only references its plan, and a
 * plan only references its offering.
 */
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

function parseListing(raw: string, page: number): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractFirstJsonObject(raw));
  } catch (error) {
    throw new CfMetricsError(
      "SERVICE_INSTANCE_NOT_FOUND",
      `cf curl /v3/service_instances (page ${String(page)}) did not return a JSON document.`,
      { cause: error },
    );
  }
  if (!isRecord(parsed)) {
    throw new CfMetricsError(
      "SERVICE_INSTANCE_NOT_FOUND",
      `cf curl /v3/service_instances (page ${String(page)}) returned an unexpected shape.`,
    );
  }
  return parsed;
}

/**
 * Every Cloud Logging service instance in the space, via the v3 API.
 *
 * Replaces `cf services`, which the CF CLI implements as one request per
 * instance in the space (bindings, last operation, upgrade availability) and
 * which measured 15–38 seconds on a real space with 39 instances — most of
 * the command's total runtime. Two requests instead: the space's GUID, then
 * one listing that already includes each instance's GUID and, through the
 * `fields[...]` sidecars, the offering name needed to pick the right ones.
 */
export async function listCloudLoggingInstances(spaceName: string, ctx: CfExecContext): Promise<readonly CloudLoggingInstance[]> {
  const spaceGuid = await cfSpaceGuid(spaceName, ctx);
  const instances: ManagedInstance[] = [];
  let page = 1;
  let hasMore = true;
  while (hasMore && page <= MAX_INSTANCE_PAGES) {
    const raw = await cfCurl(
      `/v3/service_instances?space_guids=${encodeURIComponent(spaceGuid)}&type=managed` +
        `&per_page=${String(INSTANCES_PAGE_SIZE)}&page=${String(page)}${INSTANCE_LISTING_FIELDS}`,
      ctx,
    );
    const payload = parseListing(raw, page);
    instances.push(...parseInstancesPage(payload));
    const pagination = payload["pagination"];
    const reported = isRecord(pagination) ? pagination["total_pages"] : undefined;
    hasMore = page < (typeof reported === "number" && reported > 0 ? reported : 1);
    page += 1;
  }
  return instances
    .filter((instance) => instance.offering?.toLowerCase() === CLOUD_LOGGING_OFFERING)
    .map(({ name, guid }) => ({ name, guid }));
}

/** Auto-discover the single Cloud Logging instance in the space, failing closed on 0 or many. */
export async function discoverServiceInstance(spaceName: string, ctx: CfExecContext): Promise<CloudLoggingInstance> {
  const instances = await listCloudLoggingInstances(spaceName, ctx);
  if (instances.length > 1) {
    const names = instances.map((instance) => instance.name).join(", ");
    throw new CfMetricsError(
      "SERVICE_INSTANCE_AMBIGUOUS",
      `Multiple "${CLOUD_LOGGING_OFFERING}" service instances found in this space (${names}); ` +
        "pass --service-instance to pick one.",
    );
  }
  const [only] = instances;
  if (only === undefined) {
    throw new CfMetricsError(
      "SERVICE_INSTANCE_NOT_FOUND",
      `No "${CLOUD_LOGGING_OFFERING}" service instance found in this space. ` +
        "Pass --service-instance to name one explicitly.",
    );
  }
  return only;
}
