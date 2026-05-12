import { getAllRegions } from "../config/regions.js";
import type { CfStructure, RegionKey, RegionNode, RuntimeSyncState } from "../types.js";

export function orderRegionKeys(
  keys: readonly RegionKey[],
  requestedRegionKeys: readonly RegionKey[],
): readonly RegionKey[] {
  const requested = new Map(requestedRegionKeys.map((key, index) => [key, index]));
  return [...new Set(keys)].sort((left, right) => {
    const leftIndex = requested.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = requested.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

export function orderRegions(
  regions: readonly RegionNode[],
  requestedRegionKeys: readonly RegionKey[],
): readonly RegionNode[] {
  const requested = new Map(requestedRegionKeys.map((key, index) => [key, index]));
  return [...regions].sort((left, right) => {
    const leftIndex = requested.get(left.key) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = requested.get(right.key) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

export function upsertRegion(
  structure: CfStructure,
  region: RegionNode,
  requestedRegionKeys: readonly RegionKey[],
  syncedAt: string,
): CfStructure {
  const regions = structure.regions.filter((candidate) => candidate.key !== region.key);
  return {
    syncedAt,
    regions: orderRegions([...regions, region], requestedRegionKeys),
  };
}

export function stableRegionOrder(structure: CfStructure | undefined): readonly RegionKey[] {
  const existingKeys = structure?.regions.map((region) => region.key) ?? [];
  const catalogKeys = getAllRegions().map((region) => region.key);
  return [...new Set([...existingKeys, ...catalogKeys])];
}

export function mergeRegionIntoRuntimeState(
  current: RuntimeSyncState,
  region: RegionNode,
  requestedRegionKeys: readonly RegionKey[],
  updatedAt: string,
): RuntimeSyncState {
  return {
    ...current,
    updatedAt,
    completedRegionKeys: orderRegionKeys([...current.completedRegionKeys, region.key], requestedRegionKeys),
    structure: upsertRegion(current.structure, region, requestedRegionKeys, updatedAt),
  };
}

export function mergeRegionIntoStableStructure(
  current: CfStructure | undefined,
  region: RegionNode,
  updatedAt: string,
): CfStructure {
  return upsertRegion(
    current ?? {
      syncedAt: updatedAt,
      regions: [],
    },
    region,
    stableRegionOrder(current),
    updatedAt,
  );
}

export function mergeCompletedStructureIntoStableStructure(
  current: CfStructure | undefined,
  completed: CfStructure,
  syncedAt: string,
): CfStructure {
  const completedByKey = new Map(completed.regions.map((region) => [region.key, region]));
  const existingKeys = new Set<RegionKey>();
  const mergedExisting = (current?.regions ?? []).map((region) => {
    existingKeys.add(region.key);
    return completedByKey.get(region.key) ?? region;
  });
  const appended = completed.regions.filter((region) => !existingKeys.has(region.key));

  return {
    syncedAt,
    regions: [...mergedExisting, ...appended],
  };
}
