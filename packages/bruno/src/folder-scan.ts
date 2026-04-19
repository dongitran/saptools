import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseBruEnvFile } from "./bru-parser.js";
import {
  ENVIRONMENTS_DIR,
  ORG_FOLDER_PREFIX,
  parsePrefixedName,
  REGION_FOLDER_PREFIX,
  SPACE_FOLDER_PREFIX,
} from "./paths.js";
import type {
  AppFolder,
  BrunoCollection,
  BruEnvFile,
  OrgFolder,
  RegionFolder,
  SpaceFolder,
} from "./types.js";

async function safeReaddir(path: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function listFiles(path: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function loadEnvFile(path: string, name: string): Promise<BruEnvFile> {
  const raw = await readFile(path, "utf8");
  const parsed = parseBruEnvFile(raw);
  return {
    path,
    name: name.replace(/\.bru$/, ""),
    raw,
    vars: parsed.vars,
    secrets: parsed.secrets,
  };
}

async function scanAppEnvironments(appPath: string): Promise<readonly BruEnvFile[]> {
  const envDir = join(appPath, ENVIRONMENTS_DIR);
  const files = await listFiles(envDir);
  const bruFiles = files.filter((f) => f.endsWith(".bru"));
  const loaded: BruEnvFile[] = [];
  for (const file of bruFiles) {
    loaded.push(await loadEnvFile(join(envDir, file), file));
  }
  return loaded;
}

async function scanApp(spacePath: string, name: string): Promise<AppFolder> {
  const appPath = join(spacePath, name);
  const environments = await scanAppEnvironments(appPath);
  return { path: appPath, name, environments };
}

async function scanSpace(orgPath: string, dirName: string): Promise<SpaceFolder | undefined> {
  const name = parsePrefixedName(dirName, SPACE_FOLDER_PREFIX);
  if (name === undefined) {
    return undefined;
  }
  const spacePath = join(orgPath, dirName);
  const appDirs = await safeReaddir(spacePath);
  const apps: AppFolder[] = [];
  for (const appDir of appDirs) {
    apps.push(await scanApp(spacePath, appDir));
  }
  return { path: spacePath, name, apps };
}

async function scanOrg(regionPath: string, dirName: string): Promise<OrgFolder | undefined> {
  const name = parsePrefixedName(dirName, ORG_FOLDER_PREFIX);
  if (name === undefined) {
    return undefined;
  }
  const orgPath = join(regionPath, dirName);
  const spaceDirs = await safeReaddir(orgPath);
  const spaces: SpaceFolder[] = [];
  for (const spaceDir of spaceDirs) {
    const space = await scanSpace(orgPath, spaceDir);
    if (space) {
      spaces.push(space);
    }
  }
  return { path: orgPath, name, spaces };
}

async function scanRegion(root: string, dirName: string): Promise<RegionFolder | undefined> {
  const key = parsePrefixedName(dirName, REGION_FOLDER_PREFIX);
  if (key === undefined) {
    return undefined;
  }
  const regionPath = join(root, dirName);
  const orgDirs = await safeReaddir(regionPath);
  const orgs: OrgFolder[] = [];
  for (const orgDir of orgDirs) {
    const org = await scanOrg(regionPath, orgDir);
    if (org) {
      orgs.push(org);
    }
  }
  return { path: regionPath, key, orgs };
}

export async function scanCollection(root: string): Promise<BrunoCollection> {
  const regionDirs = await safeReaddir(root);
  const regions: RegionFolder[] = [];
  for (const dir of regionDirs) {
    const region = await scanRegion(root, dir);
    if (region) {
      regions.push(region);
    }
  }
  return { root, regions };
}

export interface ShorthandRef {
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
  readonly environment?: string;
  readonly filePath?: string;
}

export function parseShorthandPath(shorthand: string): ShorthandRef | undefined {
  const cleaned = shorthand.replace(/^[./]+/, "").replace(/\\/g, "/");
  const segs = cleaned.split("/").filter((s) => s.length > 0);
  if (segs.length < 4) {
    return undefined;
  }
  const [region, org, space, app, ...rest] = segs;
  if (!region || !org || !space || !app) {
    return undefined;
  }
  if (rest.length === 0) {
    return { region, org, space, app };
  }
  const filePath = rest.join("/");
  const last = rest[rest.length - 1] ?? "";
  const environment = last.endsWith(".bru") ? last.replace(/\.bru$/, "") : undefined;
  return environment
    ? { region, org, space, app, environment, filePath }
    : { region, org, space, app, filePath };
}
