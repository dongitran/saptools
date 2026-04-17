import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { cfStructurePath } from "./paths.js";
import type { CfStructure, OrgNode, RegionKey, RegionNode, SpaceNode } from "./types.js";

export async function readStructure(): Promise<CfStructure | undefined> {
  try {
    const raw = await readFile(cfStructurePath(), "utf8");
    return JSON.parse(raw) as CfStructure;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

export async function writeStructure(structure: CfStructure): Promise<void> {
  const path = cfStructurePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(structure, null, 2)}\n`, "utf8");
}

export function findRegion(structure: CfStructure, key: RegionKey): RegionNode | undefined {
  return structure.regions.find((r) => r.key === key);
}

export function findOrg(region: RegionNode, orgName: string): OrgNode | undefined {
  return region.orgs.find((o) => o.name === orgName);
}

export function findSpace(org: OrgNode, spaceName: string): SpaceNode | undefined {
  return org.spaces.find((s) => s.name === spaceName);
}

export function findApp(space: SpaceNode, appName: string): { readonly name: string } | undefined {
  return space.apps.find((a) => a.name === appName);
}
