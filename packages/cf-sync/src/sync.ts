import type { Ora } from "ora";
import ora from "ora";

import { cfApi, cfApps, cfAuth, cfOrgs, cfSpaces, cfTargetOrg, cfTargetSpace } from "./cf.js";
import { getAllRegions } from "./regions.js";
import { writeStructure } from "./structure.js";
import type {
  AppNode,
  CfStructure,
  OrgNode,
  Region,
  RegionNode,
  SpaceNode,
} from "./types.js";

export interface SyncOptions {
  readonly email: string;
  readonly password: string;
  readonly verbose?: boolean;
  readonly interactive?: boolean;
  readonly onlyRegions?: readonly string[];
}

export interface SyncResult {
  readonly structure: CfStructure;
  readonly accessibleRegions: readonly string[];
  readonly inaccessibleRegions: readonly string[];
}

interface LogCtx {
  readonly spinner: Ora | undefined;
  readonly verbose: boolean;
  readonly interactive: boolean;
}

function log(ctx: LogCtx, msg: string): void {
  if (ctx.interactive && ctx.spinner) {
    ctx.spinner.text = msg;
    return;
  }
  if (ctx.verbose) {
    process.stdout.write(`[cf-sync] ${msg}\n`);
  }
}

async function collectSpace(space: string, ctx: LogCtx, regionKey: string, org: string): Promise<SpaceNode> {
  try {
    await cfTargetSpace(org, space);
    const appNames = await cfApps();
    const apps: AppNode[] = appNames.map((name) => ({ name }));
    log(ctx, `${regionKey} • ${org}/${space}: ${apps.length.toString()} apps`);
    return { name: space, apps };
  } catch {
    log(ctx, `${regionKey} • ${org}/${space}: skipped (error)`);
    return { name: space, apps: [] };
  }
}

async function collectOrg(org: string, ctx: LogCtx, regionKey: string): Promise<OrgNode> {
  try {
    await cfTargetOrg(org);
    const spaceNames = await cfSpaces();
    const spaces: SpaceNode[] = [];
    for (const name of spaceNames) {
       
      spaces.push(await collectSpace(name, ctx, regionKey, org));
    }
    return { name: org, spaces };
  } catch {
    log(ctx, `${regionKey} • ${org}: skipped (error)`);
    return { name: org, spaces: [] };
  }
}

async function collectRegion(region: Region, email: string, password: string, ctx: LogCtx): Promise<RegionNode> {
  log(ctx, `Authenticating ${region.key}...`);
  try {
    await cfApi(region.apiEndpoint);
    await cfAuth(email, password);
  } catch {
    log(ctx, `${region.key}: no access`);
    return {
      key: region.key,
      label: region.label,
      apiEndpoint: region.apiEndpoint,
      accessible: false,
      orgs: [],
    };
  }

  try {
    const orgNames = await cfOrgs();
    log(ctx, `${region.key}: ${orgNames.length.toString()} org(s)`);
    const orgs: OrgNode[] = [];
    for (const orgName of orgNames) {
      orgs.push(await collectOrg(orgName, ctx, region.key));
    }

    return {
      key: region.key,
      label: region.label,
      apiEndpoint: region.apiEndpoint,
      accessible: true,
      orgs,
    };
  } catch {
    return {
      key: region.key,
      label: region.label,
      apiEndpoint: region.apiEndpoint,
      accessible: true,
      orgs: [],
    };
  }
}

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const allRegions = getAllRegions();
  const regions = opts.onlyRegions
    ? allRegions.filter((r) => opts.onlyRegions?.includes(r.key))
    : allRegions;

  const spinner = opts.interactive ? ora("Starting CF sync...").start() : undefined;
  const ctx: LogCtx = {
    spinner,
    verbose: opts.verbose === true,
    interactive: opts.interactive === true,
  };

  const regionNodes: RegionNode[] = [];
  for (const region of regions) {
     
    const node = await collectRegion(region, opts.email, opts.password, ctx);
    regionNodes.push(node);
  }

  const structure: CfStructure = {
    syncedAt: new Date().toISOString(),
    regions: regionNodes,
  };
  await writeStructure(structure);

  const accessible = regionNodes.filter((r) => r.accessible).map((r) => r.key);
  const inaccessible = regionNodes.filter((r) => !r.accessible).map((r) => r.key);

  if (spinner) {
    spinner.succeed(`Sync done — ${accessible.length.toString()} accessible region(s)`);
  }

  return {
    structure,
    accessibleRegions: accessible,
    inaccessibleRegions: inaccessible,
  };
}
