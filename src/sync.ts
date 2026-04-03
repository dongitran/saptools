import process from "node:process";
import ora, { type Ora } from "ora";
import { cfApi, cfAuth, cfOrgs, cfTarget, cfTargetSpace, cfApps, cfSpaces } from "./cf.js";
import { setCachedOrgs, setCachedSpaces, setCachedApps } from "./cache.js";
import { getAllRegions, getRegion } from "./regions.js";
import type { RegionKey } from "./types.js";

export interface SyncOptions {
  readonly verbose?: boolean;
  readonly interactive?: boolean;
}

function log(opts: SyncOptions, spinner: Ora | undefined, msg: string): void {
  if (opts.interactive && spinner) {
    spinner.text = msg;
  } else if (opts.verbose) {
    process.stdout.write(`[sync] ${msg}\n`);
  }
}

async function syncSpaceApps(regionKey: RegionKey, org: string, space: string, opts: SyncOptions, spinner?: Ora): Promise<void> {
  try {
    await cfTargetSpace(org, space);
    const apps = await cfApps();

    await setCachedApps(regionKey, org, space, apps);
    log(opts, spinner, `Synced ${org} / ${space}: ${apps.length.toString()} apps`);
  } catch {
    log(opts, spinner, `Skip ${org} / ${space} (CF error)`);
  }
}

async function syncOrgSpaces(regionKey: RegionKey, org: string, opts: SyncOptions, spinner?: Ora): Promise<void> {
  try {
    await cfTarget(org);
    const spaces = await cfSpaces();

    await setCachedSpaces(regionKey, org, spaces);
    log(opts, spinner, `Synced ${org}: ${spaces.length.toString()} spaces`);

    for (const space of spaces) {
      await syncSpaceApps(regionKey, org, space, opts, spinner);
    }
  } catch {
    log(opts, spinner, `Skip ${org} (CF error)`);
  }
}

// Authenticate + collect all orgs/spaces/apps for one region → write to cache
export async function syncRegion(regionKey: RegionKey, email: string, password: string, opts: SyncOptions = {}): Promise<void> {
  const region = getRegion(regionKey);
  const spinner = opts.interactive ? ora(`Syncing region: ${region.label}...`).start() : undefined;

  log(opts, spinner, `Authenticating region: ${region.label}`);

  try {
    await cfApi(region.apiEndpoint);
    await cfAuth(email, password);

    const orgs = await cfOrgs();

    await setCachedOrgs(regionKey, orgs);
    log(opts, spinner, `Found ${orgs.length.toString()} org(s) for ${region.key}`);

    for (const org of orgs) {
      await syncOrgSpaces(regionKey, org, opts, spinner);
    }

    if (spinner) spinner.succeed(`Region ${region.label} synced`);
  } catch {
    if (spinner) spinner.fail(`Region ${region.label} failed`);
    throw new Error(`Failed to sync region ${region.key}`);
  }
}

// Sync all known regions — errors in one region do not abort others
export async function syncAll(email: string, password: string, opts: SyncOptions = {}): Promise<void> {
  for (const region of getAllRegions()) {
    try {
      await syncRegion(region.key, email, password, opts);
    } catch {
      if (!opts.interactive && opts.verbose) {
        process.stdout.write(`[sync] Failed region: ${region.label}\n`);
      }
    }
  }

  if (!opts.interactive && opts.verbose) {
    process.stdout.write("[sync] Sync complete.\n");
  } else if (opts.interactive) {
    process.stdout.write("✔ All regions synced completely.\n");
  }
}
