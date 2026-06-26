import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import {
  formatCurrentCfAppSelector,
  readCurrentCfTarget,
  requireCurrentCfRegionKey,
} from "./cf/index.js";
import type { CurrentCfTarget } from "./cf/index.js";
import { cfStructurePath } from "./config/paths.js";
import {
  readDbAppView,
  readDbSnapshotView,
} from "./db/store.js";
import {
  resolveDbSyncTargetsFromCurrentTopology,
  runDbSync,
} from "./db/sync.js";
import { readRegionsView, readStructureView } from "./topology/structure.js";
import { getRegionView, runSync, syncOrg, syncRegionOrgs, syncSpace } from "./topology/sync.js";
import { REGION_KEYS } from "./types.js";
import type { RegionKey } from "./types.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    process.stderr.write(`Missing required environment variable: ${name}\n`);
    process.exit(1);
  }
  return v;
}

function parseOnlyRegions(raw: string): readonly (typeof REGION_KEYS)[number][] {
  const requested = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (requested.length === 0) {
    process.stderr.write("Error: --only must list at least one region key\n");
    process.exit(1);
  }

  const allowed = new Set<string>(REGION_KEYS);
  const invalid = requested.filter((key) => !allowed.has(key));
  if (invalid.length > 0) {
    process.stderr.write(
      `Error: unknown region key(s): ${invalid.join(", ")}\n` +
        `       allowed: ${REGION_KEYS.join(", ")}\n`,
    );
    process.exit(1);
  }

  return requested as (typeof REGION_KEYS)[number][];
}

function assertRegionKey(key: string): RegionKey {
  if (!(REGION_KEYS as readonly string[]).includes(key)) {
    throw new Error(`Unknown region key: ${key}`);
  }
  return key as RegionKey;
}

async function requireCurrentTarget(instruction: string): Promise<CurrentCfTarget> {
  const current = await readCurrentCfTarget().catch((error: unknown) => {
    throw new Error(`No current CF target found. ${instruction}`, { cause: error });
  });
  if (current !== undefined) {
    return current;
  }
  throw new Error(`No current CF target found. ${instruction}`);
}

async function resolveRegionKey(key: string | undefined): Promise<RegionKey> {
  if (key !== undefined) {
    return assertRegionKey(key);
  }
  const current = await requireCurrentTarget("Run `cf target -o <org> -s <space>` or pass a region key.");
  return requireCurrentCfRegionKey(current);
}

async function resolveOrgName(orgName: string | undefined): Promise<string> {
  if (orgName !== undefined && orgName.trim().length > 0) {
    return orgName;
  }
  return (await requireCurrentTarget("Run `cf target -o <org> -s <space>` or pass an org name.")).orgName;
}

async function resolveSpaceName(spaceName: string | undefined): Promise<string> {
  if (spaceName !== undefined && spaceName.trim().length > 0) {
    return spaceName;
  }
  return (await requireCurrentTarget("Run `cf target -o <org> -s <space>` or pass a space name.")).spaceName;
}

async function resolveDbSelector(selector: string | undefined): Promise<string | undefined> {
  if (selector === undefined || selector.includes("/")) {
    return selector;
  }
  const current = await requireCurrentTarget(
    "Run `cf target -o <org> -s <space>` or pass a full region/org/space/app selector.",
  );
  return formatCurrentCfAppSelector(current, selector);
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();
  const cliEntryPath = fileURLToPath(import.meta.url);

  program
    .name("cf-sync")
    .description("Sync SAP BTP Cloud Foundry structure to ~/.saptools/cf-structure.json");

  program
    .command("sync")
    .description("Authenticate and walk region → org → space → app for all accessible CF regions")
    .option("--verbose", "Print progress lines to stdout", false)
    .option("--no-interactive", "Disable spinner (auto-detected in CI)")
    .option(
      "--only <keys>",
      "Comma-separated list of region keys to sync (default: all)",
    )
    .action(
      async (opts: { verbose?: boolean; interactive?: boolean; only?: string }): Promise<void> => {
        const email = requireEnv("SAP_EMAIL");
        const password = requireEnv("SAP_PASSWORD");

        const onlyRegions = opts.only ? parseOnlyRegions(opts.only) : undefined;

        const isInteractive =
          opts.interactive !== false && process.stdout.isTTY && process.env["CI"] !== "true";

        const result = await runSync({
          email,
          password,
          verbose: opts.verbose ?? false,
          interactive: isInteractive,
          ...(onlyRegions ? { onlyRegions } : {}),
        });

        process.stdout.write(
          `✔ Structure written to ${cfStructurePath()}\n` +
            `  Accessible regions: ${result.accessibleRegions.length.toString()}\n` +
            `  Inaccessible regions: ${result.inaccessibleRegions.length.toString()}\n`,
        );
      },
    );

  program
    .command("regions")
    .description("Print the best available package-managed region list as JSON")
    .action(async (): Promise<void> => {
      const view = await readRegionsView();
      process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
    });

  program
    .command("read")
    .description("Print the current package-managed structure view as JSON")
    .action(async (): Promise<void> => {
      const view = await readStructureView();
      process.stdout.write(`${JSON.stringify(view ?? null, null, 2)}\n`);
    });

  program
    .command("region")
    .description("Print one region as JSON, refreshing on demand when possible")
    .argument("[key]", "Region key (default: current CF target region)")
    .option("--no-refresh", "Do not fetch the region if it is not already cached")
    .action(async (key: string | undefined, opts: { refresh?: boolean }): Promise<void> => {
      const regionKey = await resolveRegionKey(key);

      const regionOptions = {
        regionKey,
        refreshIfMissing: opts.refresh !== false,
        ...(process.env["SAP_EMAIL"] ? { email: process.env["SAP_EMAIL"] } : {}),
        ...(process.env["SAP_PASSWORD"] ? { password: process.env["SAP_PASSWORD"] } : {}),
      };

      const view = await getRegionView(regionOptions);
      process.stdout.write(`${JSON.stringify(view ?? null, null, 2)}\n`);
    });

  program
    .command("space")
    .description("Refresh one region/org/space and print the refreshed space view as JSON")
    .argument("[region]", "Region key (default: current CF target region)")
    .argument("[org]", "Cloud Foundry org name (default: current CF target org)")
    .argument("[space]", "Cloud Foundry space name (default: current CF target space)")
    .option("--verbose", "Print progress lines to stdout", false)
    .action(async (
      key: string | undefined,
      orgName: string | undefined,
      spaceName: string | undefined,
      opts: { verbose?: boolean },
    ): Promise<void> => {
      const regionKey = await resolveRegionKey(key);
      const resolvedOrgName = await resolveOrgName(orgName);
      const resolvedSpaceName = await resolveSpaceName(spaceName);

      const view = await syncSpace({
        regionKey,
        orgName: resolvedOrgName,
        spaceName: resolvedSpaceName,
        email: requireEnv("SAP_EMAIL"),
        password: requireEnv("SAP_PASSWORD"),
        verbose: opts.verbose ?? false,
      });
      process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
    });

  program
    .command("org")
    .description("Refresh one region/org and print the refreshed org view as JSON")
    .argument("[region]", "Region key (default: current CF target region)")
    .argument("[org]", "Cloud Foundry org name (default: current CF target org)")
    .option("--verbose", "Print progress lines to stdout", false)
    .action(async (key: string | undefined, orgName: string | undefined, opts: { verbose?: boolean }): Promise<void> => {
      const regionKey = await resolveRegionKey(key);
      const resolvedOrgName = await resolveOrgName(orgName);

      const view = await syncOrg({
        regionKey,
        orgName: resolvedOrgName,
        email: requireEnv("SAP_EMAIL"),
        password: requireEnv("SAP_PASSWORD"),
        verbose: opts.verbose ?? false,
      });
      process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
    });

  program
    .command("orgs")
    .description("Refresh one region org list and print the refreshed region view as JSON")
    .argument("[region]", "Region key (default: current CF target region)")
    .option("--verbose", "Print progress lines to stdout", false)
    .action(async (key: string | undefined, opts: { verbose?: boolean }): Promise<void> => {
      const regionKey = await resolveRegionKey(key);

      const view = await syncRegionOrgs({
        regionKey,
        email: requireEnv("SAP_EMAIL"),
        password: requireEnv("SAP_PASSWORD"),
        verbose: opts.verbose ?? false,
      });
      process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
    });

  program
    .command("db-sync")
    .description("Start a background HANA DB binding sync for all cached apps or one app")
    .argument("[selector]", "Optional app selector: `<app>` or `region/org/space/app`")
    .action(async (selector?: string): Promise<void> => {
      requireEnv("SAP_EMAIL");
      requireEnv("SAP_PASSWORD");
      const resolvedSelector = await resolveDbSelector(selector);
      await resolveDbSyncTargetsFromCurrentTopology(resolvedSelector);

      const syncId = randomUUID();
      const child = spawn(
        process.execPath,
        [
          cliEntryPath,
          "db-sync-worker",
          "--sync-id",
          syncId,
          ...(resolvedSelector ? [resolvedSelector] : []),
        ],
        {
          detached: true,
          stdio: "ignore",
          env: process.env,
        },
      );
      child.unref();

      process.stdout.write(
          `Background DB sync requested.\n` +
          `  Sync id: ${syncId}\n` +
          `  Target: ${resolvedSelector ?? "all cached apps"}\n` +
          `  Use \`cf-sync db-read${resolvedSelector ? ` ${resolvedSelector}` : ""}\` to inspect results.\n`,
      );
    });

  program
    .command("db-read")
    .description("Print the best available HANA DB snapshot or one app binding view as JSON")
    .argument("[selector]", "Optional app selector: `<app>` or `region/org/space/app`")
    .action(async (selector?: string): Promise<void> => {
      const resolvedSelector = await resolveDbSelector(selector);
      const view = resolvedSelector ? await readDbAppView(resolvedSelector) : await readDbSnapshotView();
      process.stdout.write(`${JSON.stringify(view ?? null, null, 2)}\n`);
    });

  program
    .command("db-sync-worker")
    .description("Internal worker command for detached DB sync execution")
    .argument("[selector]")
    .requiredOption("--sync-id <id>")
    .action(async (selector: string | undefined, opts: { syncId: string }): Promise<void> => {
      const email = requireEnv("SAP_EMAIL");
      const password = requireEnv("SAP_PASSWORD");
      const resolvedSelector = await resolveDbSelector(selector);
      const targets = await resolveDbSyncTargetsFromCurrentTopology(resolvedSelector);
      await runDbSync({
        email,
        password,
        targets,
        syncId: opts.syncId,
        verbose: false,
      });
    });

  await program.parseAsync([...argv]);
}

try {
  await main(process.argv);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}
