import { getApiEndpointForRegion, readCurrentCfTarget } from "./cf.js";
import { CLI_NAME } from "./config.js";
import { CfMetricsError } from "./errors.js";
import type { ResolvedTarget } from "./types.js";

export interface TargetOptions {
  readonly region?: string;
  readonly org?: string;
  readonly space?: string;
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Resolve region/org/space from explicit flags, falling back to the ambient
 * `cf target` session for whichever piece is missing. Any piece filled in
 * from ambient state makes the whole resolution "ambient" for notice
 * purposes, even if some flags were pinned explicitly.
 */
export async function resolveTarget(opts: TargetOptions): Promise<ResolvedTarget> {
  const region = optionalText(opts.region);
  const org = optionalText(opts.org);
  const space = optionalText(opts.space);

  if (region !== undefined && org !== undefined && space !== undefined) {
    const apiEndpoint = getApiEndpointForRegion(region);
    if (apiEndpoint === undefined) {
      throw new CfMetricsError("TARGET_UNRESOLVED", `Unknown SAP CF region "${region}"`);
    }
    return { apiEndpoint, region, org, space, selectorSource: "explicit", regionConfirmed: true };
  }

  const current = await readCurrentCfTarget();
  if (current === undefined) {
    const missing = [
      region === undefined ? "--region" : undefined,
      org === undefined ? "--org" : undefined,
      space === undefined ? "--space" : undefined,
    ].filter((flag): flag is string => flag !== undefined);
    throw new CfMetricsError(
      "TARGET_UNRESOLVED",
      `region/org/space could not be determined (missing: ${missing.join(", ")}) and no ambient ` +
        "'cf target' session was found. Pass --region/--org/--space explicitly, or run `cf login`.",
    );
  }

  const resolvedRegion = region ?? current.regionKey;
  if (resolvedRegion === undefined) {
    throw new CfMetricsError(
      "TARGET_UNRESOLVED",
      "--region was not passed and the ambient 'cf target' API endpoint could not be mapped to a " +
        "known SAP region; pass --region explicitly.",
    );
  }
  const apiEndpoint = region === undefined ? current.apiEndpoint : getApiEndpointForRegion(region);
  if (apiEndpoint === undefined) {
    throw new CfMetricsError("TARGET_UNRESOLVED", `Unknown SAP CF region "${resolvedRegion}"`);
  }

  return {
    apiEndpoint,
    region: resolvedRegion,
    org: org ?? current.orgName,
    space: space ?? current.spaceName,
    selectorSource: "ambient",
    regionConfirmed: current.regionKey !== undefined,
  };
}

/** Print the same style of resolved-target notice `cf-hana`/`cf-otel` print, adapted to three flags. */
export function printResolvedTarget(target: ResolvedTarget): void {
  const selector = `${target.region}/${target.org}/${target.space}`;
  if (target.selectorSource !== "ambient") {
    process.stderr.write(`${CLI_NAME}: target ${selector} (explicit)\n`);
    return;
  }
  if (!target.regionConfirmed) {
    process.stderr.write(
      `${CLI_NAME}: target ${selector} (resolved from ambient 'cf target'; region could not be ` +
        "mapped, so pin explicitly with --region/--org/--space)\n",
    );
    return;
  }
  process.stderr.write(
    `${CLI_NAME}: target ${selector} (resolved from ambient 'cf target'; ` +
      "pass --region/--org/--space to pin)\n",
  );
}
