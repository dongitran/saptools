#!/usr/bin/env node
import process from "node:process";
import ora from "ora";
import { getRegion } from "./regions.js";
import { cfApi, cfAuth, cfOrgs, cfTarget, cfTargetSpace, cfApps, cfEnv } from "./cf.js";
import { promptAction, promptRegion, promptOrg, promptSpace, promptApps } from "./prompts.js";
import { parseVcapServices, extractHanaCredentials } from "./parser.js";
import { writeCredentials } from "./writer.js";
import { updateVscodeConnections } from "./vscode.js";
import { getCachedOrgs, setCachedOrgs, getCachedApps, setCachedApps } from "./cache.js";
import { syncAll } from "./sync.js";
import { runCronjob } from "./cronjob.js";
import type { AppHanaEntry, RegionKey } from "./types.js";

function getEnvCredentials(): { email: string; password: string } {
  const email = process.env["SAP_EMAIL"];
  const password = process.env["SAP_PASSWORD"];

  if (!email || !password) {
    process.stderr.write(
      [
        "Error: SAP_EMAIL and SAP_PASSWORD environment variables must be set.",
        "",
        "  export SAP_EMAIL=your@email.com",
        "  export SAP_PASSWORD=your-secret-password",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  return { email, password };
}

async function extractForApp(appName: string, org: string, space: string, regionKey: RegionKey): Promise<AppHanaEntry | null> {
  const rawEnv = await cfEnv(appName);
  const vcap = parseVcapServices(rawEnv);

  if (!vcap.hana || vcap.hana.length === 0) return null;

  const binding = vcap.hana[0];

  if (binding === undefined) return null;

  return { app: appName, org, space, region: regionKey, hana: extractHanaCredentials(binding) };
}

async function runSync(): Promise<void> {
  const { email, password } = getEnvCredentials();

  process.stdout.write("Running manual sync for all regions...\n");
  await syncAll(email, password, { verbose: true, interactive: true });
}

async function loadOrgs(regionKey: RegionKey): Promise<{ orgs: string[]; cached: boolean }> {
  const cached = await getCachedOrgs(regionKey);

  if (cached) return { orgs: cached, cached: true };

  const orgs = await cfOrgs();

  await setCachedOrgs(regionKey, orgs).catch(() => undefined);

  return { orgs, cached: false };
}

async function loadApps(regionKey: RegionKey, org: string, space: string): Promise<{ apps: string[]; cached: boolean }> {
  const cached = await getCachedApps(regionKey, org, space);

  if (cached) return { apps: cached, cached: true };

  const apps = await cfApps();

  await setCachedApps(regionKey, org, space, apps).catch(() => undefined);

  return { apps, cached: false };
}

async function main(): Promise<void> {
  const { email, password } = getEnvCredentials();

  // Step 1: Main Action
  const action = await promptAction();

  if (action === "SYNC") {
    await runSync();
    process.stdout.write("\n");
    await main();
    return;
  }

  // Step 2: Choose region (EXTRACT mode)
  const regionKey = await promptRegion();
  const region = getRegion(regionKey);

  // Step 2: Connect + authenticate (always needed for cfEnv later)
  const connectSpinner = ora(`Connecting to ${region.label}...`).start();

  try {
    await cfApi(region.apiEndpoint);
    connectSpinner.succeed(`Connected to ${region.label}`);
  } catch (err: unknown) {
    connectSpinner.fail(`Failed to reach ${region.label}`);
    throw err;
  }

  const authSpinner = ora("Authenticating...").start();

  try {
    await cfAuth(email, password);
    authSpinner.succeed(`Authenticated as ${email}`);
  } catch (err: unknown) {
    authSpinner.fail("Authentication failed");
    throw err;
  }

  // Step 3: Load orgs (cache-first)
  const orgsSpinner = ora("Loading organizations...").start();
  let orgs: string[];

  try {
    const result = await loadOrgs(regionKey);

    orgs = result.orgs;
    orgsSpinner.succeed(`Found ${orgs.length.toString()} organization(s)${result.cached ? " (cached)" : ""}`);
  } catch (err: unknown) {
    orgsSpinner.fail("Failed to load organizations");
    throw err;
  }

  if (orgs.length === 0) {
    process.stderr.write("No orgs found for this account in this region.\n");
    process.exit(1);
  }

  const org = await promptOrg(orgs);

  // Step 4: Target org → fetch spaces
  const spacesSpinner = ora(`Loading spaces for ${org}...`).start();
  let spaces: string[];

  try {
    const targetResult = await cfTarget(org);

    spaces = targetResult.spaces;
    spacesSpinner.succeed(`Found ${spaces.length.toString()} space(s)`);
  } catch (err: unknown) {
    spacesSpinner.fail(`Failed to load spaces for ${org}`);
    throw err;
  }

  const space = await promptSpace(spaces);

  const targetSpinner = ora(`Targeting ${org} / ${space}...`).start();

  try {
    await cfTargetSpace(org, space);
    targetSpinner.succeed(`Targeted: ${org} / ${space}`);
  } catch (err: unknown) {
    targetSpinner.fail("Failed to set target");
    throw err;
  }

  // Step 5: Load apps (cache-first — biggest speedup for large orgs)
  const appsSpinner = ora("Loading apps...").start();
  let apps: string[];

  try {
    const result = await loadApps(regionKey, org, space);

    apps = result.apps;
    appsSpinner.succeed(`Found ${apps.length.toString()} app(s)${result.cached ? " (cached)" : ""}`);
  } catch (err: unknown) {
    appsSpinner.fail("Failed to load apps");
    throw err;
  }

  if (apps.length === 0) {
    process.stderr.write("No apps found in this org/space.\n");
    process.exit(1);
  }

  const selectedApps = await promptApps(apps);

  // Step 6: Extract HANA credentials
  process.stdout.write("\n");
  const entries: AppHanaEntry[] = [];

  for (const appName of selectedApps) {
    const extractSpinner = ora(`Extracting HANA credentials: ${appName}`).start();

    try {
      const entry = await extractForApp(appName, org, space, regionKey);

      if (entry) {
        entries.push(entry);
        extractSpinner.succeed(appName);
      } else {
        extractSpinner.warn(`${appName} — no HANA binding found`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      extractSpinner.fail(`${appName} — ${message}`);
    }
  }

  if (entries.length === 0) {
    process.stderr.write("\nNo HANA credentials found for selected apps.\n");
    process.exit(1);
  }

  // Step 7: Write JSON credentials file
  const writeSpinner = ora("Writing credentials to file...").start();

  try {
    const filePath = await writeCredentials(entries);

    writeSpinner.succeed(`Saved ${entries.length.toString()} entries \u2192 ${filePath}`);
  } catch (err: unknown) {
    writeSpinner.fail("Failed to write output file");
    throw err;
  }

  // Step 8: Update .vscode/settings.json sqltools.connections in cwd
  const vscodeSpinner = ora("Updating .vscode/settings.json (sqltools.connections)...").start();

  try {
    const settingsPath = await updateVscodeConnections(entries);

    vscodeSpinner.succeed(`SQLTools connections updated \u2192 ${settingsPath}`);
  } catch {
    vscodeSpinner.warn("Could not update .vscode/settings.json (non-fatal)");
  }
}

async function entrypoint(): Promise<void> {
  const subcommand = process.argv[2];
  const subArgs = process.argv.slice(3);

  if (subcommand === "sync") {
    await runSync();
    return;
  }

  if (subcommand === "cronjob") {
    await runCronjob(subArgs[0]);
    return;
  }

  await main();
}

entrypoint().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);

  process.stderr.write(`\nFatal error: ${message}\n`);
  process.exit(1);
});
