import type { CfStructure, OrgNode, RegionKey, RegionNode, SpaceNode } from "../types.js";

export function findRegion(structure: CfStructure, key: RegionKey): RegionNode | undefined {
  return structure.regions.find((region) => region.key === key);
}

export function findOrg(region: RegionNode, orgName: string): OrgNode | undefined {
  return region.orgs.find((org) => org.name === orgName);
}

export function findSpace(org: OrgNode, spaceName: string): SpaceNode | undefined {
  return org.spaces.find((space) => space.name === spaceName);
}

export function findApp(space: SpaceNode, appName: string): { readonly name: string } | undefined {
  return space.apps.find((app) => app.name === appName);
}
