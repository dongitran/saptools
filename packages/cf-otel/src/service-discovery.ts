import type { CfExecContext, CfServiceRow } from "./cf.js";
import { cfServices, parseServicesTable } from "./cf.js";
import { CfOtelError } from "./errors.js";

const CLOUD_LOGGING_OFFERING = "cloud-logging";

/** List every Cloud Logging service instance in the currently targeted space. */
export async function listCloudLoggingInstances(ctx: CfExecContext): Promise<readonly CfServiceRow[]> {
  const stdout = await cfServices(ctx);
  return parseServicesTable(stdout).filter((row) => row.offering.toLowerCase() === CLOUD_LOGGING_OFFERING);
}

/**
 * Auto-discover the single Cloud Logging instance in the space, failing closed
 * on 0 or many.
 *
 * Returns the whole row rather than just its name, because the row already
 * carries the instance's `boundApps` and the caller needs them for the
 * fallback-binding step. Returning the name alone meant that step ran
 * `cf services` a second time purely to read `boundApps` off this same row —
 * measured at 11.8s and 15.9s in one traced cold command on a real tenant,
 * 27.7s of a 40.6s total.
 */
export async function discoverServiceInstance(ctx: CfExecContext): Promise<CfServiceRow> {
  const rows = await listCloudLoggingInstances(ctx);
  if (rows.length > 1) {
    const names = rows.map((row) => row.name).join(", ");
    throw new CfOtelError(
      "SERVICE_INSTANCE_AMBIGUOUS",
      `Multiple "${CLOUD_LOGGING_OFFERING}" service instances found in this space (${names}); ` +
        "pass --service-instance to pick one.",
    );
  }
  const [only] = rows;
  if (only === undefined) {
    throw new CfOtelError(
      "SERVICE_INSTANCE_NOT_FOUND",
      `No "${CLOUD_LOGGING_OFFERING}" service instance found in this space. ` +
        "Pass --service-instance to name one explicitly.",
    );
  }
  return only;
}

/**
 * Find every app bound to a named service instance in the current space.
 *
 * Only needed when the caller pinned `--service-instance`, since that is the
 * one path where no `cf services` listing has been fetched yet;
 * {@link discoverServiceInstance} hands its own row's `boundApps` straight to
 * the caller.
 */
export async function findBoundApps(instanceName: string, ctx: CfExecContext): Promise<readonly string[]> {
  const stdout = await cfServices(ctx);
  const row = parseServicesTable(stdout).find((candidate) => candidate.name === instanceName);
  return row?.boundApps ?? [];
}
