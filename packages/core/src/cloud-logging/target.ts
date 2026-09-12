import type { CloudLoggingCfExecutor, ResolvedTarget } from "./types.js";

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
 *
 * Ported verbatim (logic unchanged) from `@saptools/cf-metrics`'s
 * `target.ts`, confirmed 2026-09-12 to be structurally identical to
 * `@saptools/cf-otel`'s own copy (only the thrown error class differed) —
 * the two packages' `TargetError`-style failures are represented here as a
 * plain `Error`; each consumer wraps it in its own error class at the call
 * site if it needs a typed code.
 */
export async function resolveTarget(opts: TargetOptions, executor: CloudLoggingCfExecutor): Promise<ResolvedTarget> {
  const region = optionalText(opts.region);
  const org = optionalText(opts.org);
  const space = optionalText(opts.space);

  if (region !== undefined && org !== undefined && space !== undefined) {
    const apiEndpoint = executor.getApiEndpointForRegion(region);
    if (apiEndpoint === undefined) {
      throw new Error(`Unknown SAP CF region "${region}"`);
    }
    return { apiEndpoint, region, org, space, selectorSource: "explicit", regionConfirmed: true };
  }

  const current = await executor.readCurrentCfTarget();
  if (current === undefined) {
    const missing = [
      region === undefined ? "--region" : undefined,
      org === undefined ? "--org" : undefined,
      space === undefined ? "--space" : undefined,
    ].filter((flag): flag is string => flag !== undefined);
    throw new Error(
      `region/org/space could not be determined (missing: ${missing.join(", ")}) and no ambient ` +
        "'cf target' session was found. Pass --region/--org/--space explicitly, or run `cf login`.",
    );
  }

  const resolvedRegion = region ?? current.regionKey;
  if (resolvedRegion === undefined) {
    throw new Error(
      "--region was not passed and the ambient 'cf target' API endpoint could not be mapped to a " +
        "known SAP region; pass --region explicitly.",
    );
  }
  const apiEndpoint = region === undefined ? current.apiEndpoint : executor.getApiEndpointForRegion(region);
  if (apiEndpoint === undefined) {
    throw new Error(`Unknown SAP CF region "${resolvedRegion}"`);
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

/** Print the same style of resolved-target notice every @saptools Cloud Logging CLI already prints, generalized to any CLI name. */
export function printResolvedTarget(target: ResolvedTarget, cliName: string): void {
  const selector = `${target.region}/${target.org}/${target.space}`;
  if (target.selectorSource !== "ambient") {
    process.stderr.write(`${cliName}: target ${selector} (explicit)\n`);
    return;
  }
  if (!target.regionConfirmed) {
    process.stderr.write(
      `${cliName}: target ${selector} (resolved from ambient 'cf target'; region could not be ` +
        "mapped, so pin explicitly with --region/--org/--space)\n",
    );
    return;
  }
  process.stderr.write(
    `${cliName}: target ${selector} (resolved from ambient 'cf target'; ` +
      "pass --region/--org/--space to pin)\n",
  );
}
