import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { OrgNode, RegionKey, RegionNode, SpaceNode } from "@saptools/cf-sync";

import type { CfInfoDeps } from "./cf-info.js";
import { defaultCfInfoDeps, listRegionsWithContent } from "./cf-info.js";
import { writeCfMetaToFile } from "./cf-meta.js";
import {
  ENVIRONMENTS_DIR,
  orgFolderName,
  regionFolderName,
  spaceFolderName,
} from "./paths.js";
import type { CfAppRef } from "./types.js";

export interface EnvironmentSelection {
  readonly common: readonly string[];
  readonly existing: readonly string[];
}

export interface SetupAppPrompts {
  readonly selectRegion: (choices: readonly { value: RegionKey; name: string }[]) => Promise<RegionKey>;
  readonly selectOrg: (choices: readonly { value: string; name: string }[]) => Promise<string>;
  readonly selectSpace: (choices: readonly { value: string; name: string }[]) => Promise<string>;
  readonly selectApp: (choices: readonly { value: string; name: string }[]) => Promise<string>;
  readonly confirmCreate: (path: string) => Promise<boolean>;
  readonly selectEnvironments: (opts: EnvironmentSelection) => Promise<readonly string[]>;
}

export interface SetupAppOptions {
  readonly root: string;
  readonly prompts: SetupAppPrompts;
  readonly deps?: CfInfoDeps;
  readonly log?: (msg: string) => void;
}

export interface SetupAppResult {
  readonly ref: CfAppRef;
  readonly appPath: string;
  readonly environments: readonly string[];
  readonly created: boolean;
}

export const COMMON_ENVIRONMENTS = ["local", "dev", "staging", "prod"] as const;
const BRUNO_COLLECTION_CONFIG_FILENAME = "bruno.json";

export const ENV_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function assertValidEnvName(name: string): void {
  if (!ENV_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid environment name '${name}': only letters, digits, dot, underscore, and dash are allowed.`,
    );
  }
}

function emptyEnvContent(envName: string, ref: CfAppRef): string {
  const lines = [
    "vars {",
    `  __cf_region: ${ref.region}`,
    `  __cf_org: ${ref.org}`,
    `  __cf_space: ${ref.space}`,
    `  __cf_app: ${ref.app}`,
    `  environment: ${envName}`,
    "  baseUrl: ",
    "}",
    "",
  ];
  return lines.join("\n");
}

function normalizeCollectionName(root: string): string {
  const candidate = basename(root).replace(/^\.+/, "").trim();
  return candidate.length > 0 ? candidate : "bruno-collection";
}

function defaultBrunoConfig(root: string): string {
  return `${JSON.stringify(
    {
      version: "1",
      name: normalizeCollectionName(root),
      type: "collection",
      ignore: ["node_modules", ".git"],
    },
    null,
    2,
  )}\n`;
}

async function ensureCollectionConfig(root: string): Promise<void> {
  const filePath = join(root, BRUNO_COLLECTION_CONFIG_FILENAME);
  try {
    await writeFile(filePath, defaultBrunoConfig(root), { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
  }
}

async function ensureEnvFile(appPath: string, envName: string, ref: CfAppRef): Promise<string> {
  const envDir = join(appPath, ENVIRONMENTS_DIR);
  await mkdir(envDir, { recursive: true });
  const filePath = join(envDir, `${envName}.bru`);
  try {
    await writeFile(filePath, emptyEnvContent(envName, ref), { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
    await writeCfMetaToFile(filePath, ref);
  }
  return filePath;
}

function pickRegion(regions: readonly { key: RegionKey; label: string; orgCount: number }[]): readonly {
  readonly value: RegionKey;
  readonly name: string;
}[] {
  return regions.map((r) => ({ value: r.key, name: `${r.key} — ${r.label} (${r.orgCount.toString()} org${r.orgCount === 1 ? "" : "s"})` }));
}

function pickOrg(region: RegionNode): readonly { value: string; name: string }[] {
  return region.orgs.map((o) => ({ value: o.name, name: `${o.name} (${o.spaces.length.toString()} space${o.spaces.length === 1 ? "" : "s"})` }));
}

function pickSpace(org: OrgNode): readonly { value: string; name: string }[] {
  return org.spaces.map((s) => ({ value: s.name, name: `${s.name} (${s.apps.length.toString()} app${s.apps.length === 1 ? "" : "s"})` }));
}

function pickApp(space: SpaceNode): readonly { value: string; name: string }[] {
  return space.apps.map((a) => ({ value: a.name, name: a.name }));
}

export async function setupApp(options: SetupAppOptions): Promise<SetupAppResult> {
  const deps = options.deps ?? defaultCfInfoDeps;
  const log = options.log ?? ((): void => undefined);

  const regions = await listRegionsWithContent(deps);
  if (regions.length === 0) {
    throw new Error(
      "No CF regions with orgs are cached. Run `cf-sync sync` first, or pass SAP_EMAIL/SAP_PASSWORD to refresh.",
    );
  }

  const regionKey = await options.prompts.selectRegion(pickRegion(regions));
  const regionView = await deps.readRegionView(regionKey);
  if (!regionView) {
    throw new Error(`Region ${regionKey} is not cached. Run \`cf-sync sync\` or \`cf-sync region ${regionKey}\`.`);
  }
  const region = regionView.region;

  if (region.orgs.length === 0) {
    throw new Error(`Region ${regionKey} has no accessible orgs.`);
  }

  const orgName = await options.prompts.selectOrg(pickOrg(region));
  const org = region.orgs.find((o) => o.name === orgName);
  if (!org) {
    throw new Error(`Org ${orgName} not found in region ${regionKey}`);
  }
  if (org.spaces.length === 0) {
    throw new Error(`Org ${orgName} has no spaces.`);
  }

  const spaceName = await options.prompts.selectSpace(pickSpace(org));
  const space = org.spaces.find((s) => s.name === spaceName);
  if (!space) {
    throw new Error(`Space ${spaceName} not found in org ${orgName}`);
  }
  if (space.apps.length === 0) {
    throw new Error(`Space ${spaceName} has no apps.`);
  }

  const appName = await options.prompts.selectApp(pickApp(space));
  const ref: CfAppRef = { region: regionKey, org: orgName, space: spaceName, app: appName };

  const appPath = join(
    options.root,
    regionFolderName(regionKey),
    orgFolderName(orgName),
    spaceFolderName(spaceName),
    appName,
  );

  const confirmed = await options.prompts.confirmCreate(appPath);
  if (!confirmed) {
    return { ref, appPath, environments: [], created: false };
  }

  await mkdir(options.root, { recursive: true });
  await ensureCollectionConfig(options.root);
  await mkdir(appPath, { recursive: true });

  const existingEnvs = await listExistingEnvs(appPath);
  const common = [...COMMON_ENVIRONMENTS];
  const selected = await options.prompts.selectEnvironments({ common, existing: existingEnvs });
  const merged: string[] = [];
  for (const name of selected) {
    const trimmed = name.trim();
    if (trimmed.length === 0 || merged.includes(trimmed)) {
      continue;
    }
    assertValidEnvName(trimmed);
    merged.push(trimmed);
  }
  if (merged.length === 0) {
    throw new Error("At least one environment is required.");
  }

  const created: string[] = [];
  for (const envName of merged) {
    const path = await ensureEnvFile(appPath, envName, ref);
    created.push(path);
    log(`• ${path}`);
  }

  return { ref, appPath, environments: created, created: true };
}

async function listExistingEnvs(appPath: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(join(appPath, ENVIRONMENTS_DIR), { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".bru"))
      .map((e) => e.name.replace(/\.bru$/, ""));
  } catch {
    return [];
  }
}
