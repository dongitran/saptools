import type { CfExecContext, CfServiceRow } from "./cf.js";
import { cfServices, parseServicesTable } from "./cf.js";
import { CfMetricsError } from "./errors.js";

const CLOUD_LOGGING_OFFERING = "cloud-logging";

/** List every Cloud Logging service instance in the currently targeted space. */
export async function listCloudLoggingInstances(ctx: CfExecContext): Promise<readonly CfServiceRow[]> {
  const stdout = await cfServices(ctx);
  return parseServicesTable(stdout).filter((row) => row.offering.toLowerCase() === CLOUD_LOGGING_OFFERING);
}

/** Auto-discover the single Cloud Logging instance in the space, failing closed on 0 or many. */
export async function discoverServiceInstance(ctx: CfExecContext): Promise<string> {
  const rows = await listCloudLoggingInstances(ctx);
  if (rows.length > 1) {
    const names = rows.map((row) => row.name).join(", ");
    throw new CfMetricsError(
      "SERVICE_INSTANCE_AMBIGUOUS",
      `Multiple "${CLOUD_LOGGING_OFFERING}" service instances found in this space (${names}); ` +
        "pass --service-instance to pick one.",
    );
  }
  const [only] = rows;
  if (only === undefined) {
    throw new CfMetricsError(
      "SERVICE_INSTANCE_NOT_FOUND",
      `No "${CLOUD_LOGGING_OFFERING}" service instance found in this space. ` +
        "Pass --service-instance to name one explicitly.",
    );
  }
  return only.name;
}

/** Find every app bound to a named service instance in the current space. */
export async function findBoundApps(instanceName: string, ctx: CfExecContext): Promise<readonly string[]> {
  const stdout = await cfServices(ctx);
  const row = parseServicesTable(stdout).find((candidate) => candidate.name === instanceName);
  return row?.boundApps ?? [];
}
