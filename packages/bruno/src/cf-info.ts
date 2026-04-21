import type {
  CfStructure,
  OrgNode,
  RegionKey,
  RegionNode,
  RegionsView,
  RegionView,
  SpaceNode,
  StructureView,
} from "@saptools/cf-sync";
import {
  getRegionView as getRegionViewApi,
  readRegionsView,
  readRegionView,
  readStructureView,
  REGION_KEYS,
} from "@saptools/cf-sync";

export interface CfInfoDeps {
  readonly readStructureView: () => Promise<StructureView | undefined>;
  readonly readRegionsView: () => Promise<RegionsView>;
  readonly readRegionView: (key: RegionKey) => Promise<RegionView | undefined>;
  readonly getRegionView: (opts: {
    readonly regionKey: RegionKey;
    readonly email?: string;
    readonly password?: string;
    readonly refreshIfMissing?: boolean;
  }) => Promise<RegionView | undefined>;
}

export const defaultCfInfoDeps: CfInfoDeps = {
  readStructureView,
  readRegionsView,
  readRegionView,
  getRegionView: getRegionViewApi,
};

export function isValidRegionKey(value: string): value is RegionKey {
  return (REGION_KEYS as readonly string[]).includes(value);
}

export interface StructureSnapshot {
  readonly source: "runtime" | "stable" | "empty";
  readonly structure: CfStructure | undefined;
  readonly stale: boolean;
  readonly message: string | undefined;
}

export async function getStructureSnapshot(
  deps: CfInfoDeps = defaultCfInfoDeps,
): Promise<StructureSnapshot> {
  const view = await deps.readStructureView();
  if (!view) {
    return {
      source: "empty",
      structure: undefined,
      stale: true,
      message: "No CF structure cached. Run `saptools-bruno sync` first.",
    };
  }

  const stale = view.source === "runtime" && view.metadata?.status === "running";
  return {
    source: view.source,
    structure: view.structure,
    stale,
    message: stale ? "A CF sync is still running — showing partial data." : undefined,
  };
}

export interface RegionSuggestion {
  readonly key: RegionKey;
  readonly label: string;
  readonly orgCount: number;
}

export async function listRegionsWithContent(
  deps: CfInfoDeps = defaultCfInfoDeps,
): Promise<readonly RegionSuggestion[]> {
  const snapshot = await getStructureSnapshot(deps);
  if (!snapshot.structure) {
    return [];
  }
  return snapshot.structure.regions
    .filter((r) => r.accessible && r.orgs.length > 0)
    .map((r) => ({ key: r.key, label: r.label, orgCount: r.orgs.length }));
}

export async function getRegion(
  key: RegionKey,
  deps: CfInfoDeps = defaultCfInfoDeps,
): Promise<RegionNode | undefined> {
  const view = await deps.readRegionView(key);
  return view?.region;
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

export interface ResolvedRef {
  readonly region: RegionNode;
  readonly org: OrgNode;
  readonly space: SpaceNode;
  readonly app: { readonly name: string };
}

export async function resolveRef(
  ref: {
    readonly region: RegionKey;
    readonly org: string;
    readonly space: string;
    readonly app: string;
  },
  deps: CfInfoDeps = defaultCfInfoDeps,
): Promise<ResolvedRef | undefined> {
  const region = await getRegion(ref.region, deps);
  if (!region) {
    return undefined;
  }
  const org = findOrg(region, ref.org);
  if (!org) {
    return undefined;
  }
  const space = findSpace(org, ref.space);
  if (!space) {
    return undefined;
  }
  const app = findApp(space, ref.app);
  if (!app) {
    return undefined;
  }
  return { region, org, space, app };
}
