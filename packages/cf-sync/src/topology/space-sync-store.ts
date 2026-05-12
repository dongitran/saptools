import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { cfRuntimeStatePath, cfStateLockPath, cfStructurePath } from "../config/paths.js";
import type {
  CfStructure,
  OrgNode,
  Region,
  RegionNode,
  RuntimeSyncState,
  SpaceNode,
  SyncMetadata,
} from "../types.js";

import { toSyncMetadata } from "./structure.js";

const FILE_LOCK_POLL_MS = 50;
const FILE_LOCK_TIMEOUT_MS = 10_000;

export interface PersistedSpaceResult {
  readonly region: RegionNode;
  readonly org: OrgNode;
  readonly space: SpaceNode;
  readonly metadata?: SyncMetadata;
}

export interface PersistedOrgResult {
  readonly region: RegionNode;
  readonly org: OrgNode;
  readonly metadata?: SyncMetadata;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

async function acquireFileLock(path: string): Promise<FileHandle> {
  const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;
  await mkdir(dirname(path), { recursive: true });

  for (;;) {
    try {
      return await open(path, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out acquiring file lock at ${path}`);
    }

    await sleep(FILE_LOCK_POLL_MS);
  }
}

async function releaseFileLock(path: string, handle: FileHandle): Promise<void> {
  await handle.close();
  await unlink(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

async function withStateLock<T>(work: () => Promise<T>): Promise<T> {
  const handle = await acquireFileLock(cfStateLockPath());

  try {
    return await work();
  } finally {
    await releaseFileLock(cfStateLockPath(), handle);
  }
}

function upsertSpace(spaces: readonly SpaceNode[], space: SpaceNode): readonly SpaceNode[] {
  if (spaces.some((candidate) => candidate.name === space.name)) {
    return spaces.map((candidate) => (candidate.name === space.name ? space : candidate));
  }
  return [...spaces, space];
}

function upsertOrgSpace(orgs: readonly OrgNode[], orgName: string, space: SpaceNode): readonly OrgNode[] {
  const existing = orgs.find((candidate) => candidate.name === orgName);
  const nextOrg: OrgNode = {
    name: orgName,
    spaces: upsertSpace(existing?.spaces ?? [], space),
  };
  if (existing) {
    return orgs.map((candidate) => (candidate.name === orgName ? nextOrg : candidate));
  }
  return [...orgs, nextOrg];
}

function upsertOrg(orgs: readonly OrgNode[], org: OrgNode): readonly OrgNode[] {
  if (orgs.some((candidate) => candidate.name === org.name)) {
    return orgs.map((candidate) => (candidate.name === org.name ? org : candidate));
  }
  return [...orgs, org];
}

function mergeSpaceIntoRegion(
  existing: RegionNode | undefined,
  region: Region,
  orgName: string,
  space: SpaceNode,
): RegionNode {
  return {
    key: region.key,
    label: existing?.label ?? region.label,
    apiEndpoint: existing?.apiEndpoint ?? region.apiEndpoint,
    accessible: true,
    orgs: upsertOrgSpace(existing?.orgs ?? [], orgName, space),
  };
}

function mergeOrgIntoRegion(
  existing: RegionNode | undefined,
  region: Region,
  org: OrgNode,
): RegionNode {
  return {
    key: region.key,
    label: existing?.label ?? region.label,
    apiEndpoint: existing?.apiEndpoint ?? region.apiEndpoint,
    accessible: true,
    orgs: upsertOrg(existing?.orgs ?? [], org),
  };
}

function mergeSpaceIntoStructure(
  current: CfStructure | undefined,
  region: Region,
  orgName: string,
  space: SpaceNode,
  syncedAt: string,
): CfStructure {
  const existingRegion = current?.regions.find((candidate) => candidate.key === region.key);
  const mergedRegion = mergeSpaceIntoRegion(existingRegion, region, orgName, space);
  const currentRegions = current?.regions ?? [];
  const regions = existingRegion
    ? currentRegions.map((candidate) => (candidate.key === region.key ? mergedRegion : candidate))
    : [...currentRegions, mergedRegion];
  return {
    syncedAt,
    regions,
  };
}

function mergeOrgIntoStructure(
  current: CfStructure | undefined,
  region: Region,
  org: OrgNode,
  syncedAt: string,
): CfStructure {
  const existingRegion = current?.regions.find((candidate) => candidate.key === region.key);
  const mergedRegion = mergeOrgIntoRegion(existingRegion, region, org);
  const currentRegions = current?.regions ?? [];
  const regions = existingRegion
    ? currentRegions.map((candidate) => (candidate.key === region.key ? mergedRegion : candidate))
    : [...currentRegions, mergedRegion];
  return {
    syncedAt,
    regions,
  };
}

function mergeSpaceIntoRuntimeState(
  current: RuntimeSyncState,
  region: Region,
  orgName: string,
  space: SpaceNode,
  updatedAt: string,
): RuntimeSyncState {
  return {
    ...current,
    updatedAt,
    structure: mergeSpaceIntoStructure(current.structure, region, orgName, space, updatedAt),
  };
}

function mergeOrgIntoRuntimeState(
  current: RuntimeSyncState,
  region: Region,
  org: OrgNode,
  updatedAt: string,
): RuntimeSyncState {
  return {
    ...current,
    updatedAt,
    structure: mergeOrgIntoStructure(current.structure, region, org, updatedAt),
  };
}

function readPersistedSpace(structure: CfStructure, region: Region, orgName: string, spaceName: string): PersistedSpaceResult {
  const persistedRegion = structure.regions.find((candidate) => candidate.key === region.key);
  const persistedOrg = persistedRegion?.orgs.find((candidate) => candidate.name === orgName);
  const persistedSpace = persistedOrg?.spaces.find((candidate) => candidate.name === spaceName);

  if (!persistedRegion || !persistedOrg || !persistedSpace) {
    throw new Error(`Failed to persist space ${region.key}/${orgName}/${spaceName}`);
  }

  return {
    region: persistedRegion,
    org: persistedOrg,
    space: persistedSpace,
  };
}

function readPersistedOrg(structure: CfStructure, region: Region, orgName: string): PersistedOrgResult {
  const persistedRegion = structure.regions.find((candidate) => candidate.key === region.key);
  const persistedOrg = persistedRegion?.orgs.find((candidate) => candidate.name === orgName);

  if (!persistedRegion || !persistedOrg) {
    throw new Error(`Failed to persist org ${region.key}/${orgName}`);
  }

  return {
    region: persistedRegion,
    org: persistedOrg,
  };
}

export async function persistSpace(
  region: Region,
  orgName: string,
  space: SpaceNode,
): Promise<PersistedSpaceResult> {
  return await withStateLock(async () => {
    const updatedAt = new Date().toISOString();
    const runtimeState = await readJsonFile<RuntimeSyncState>(cfRuntimeStatePath());

    if (runtimeState) {
      const nextRuntime = mergeSpaceIntoRuntimeState(runtimeState, region, orgName, space, updatedAt);
      await writeJsonFileAtomic(cfRuntimeStatePath(), nextRuntime);

      if (runtimeState.status !== "running") {
        const nextStable = mergeSpaceIntoStructure(await readJsonFile<CfStructure>(cfStructurePath()), region, orgName, space, updatedAt);
        await writeJsonFileAtomic(cfStructurePath(), nextStable);
      }

      return {
        ...readPersistedSpace(nextRuntime.structure, region, orgName, space.name),
        metadata: toSyncMetadata(nextRuntime),
      };
    }

    const nextStable = mergeSpaceIntoStructure(await readJsonFile<CfStructure>(cfStructurePath()), region, orgName, space, updatedAt);
    await writeJsonFileAtomic(cfStructurePath(), nextStable);
    return readPersistedSpace(nextStable, region, orgName, space.name);
  });
}

export async function persistOrg(region: Region, org: OrgNode): Promise<PersistedOrgResult> {
  return await withStateLock(async () => {
    const updatedAt = new Date().toISOString();
    const runtimeState = await readJsonFile<RuntimeSyncState>(cfRuntimeStatePath());

    if (runtimeState) {
      const nextRuntime = mergeOrgIntoRuntimeState(runtimeState, region, org, updatedAt);
      await writeJsonFileAtomic(cfRuntimeStatePath(), nextRuntime);

      if (runtimeState.status !== "running") {
        const nextStable = mergeOrgIntoStructure(
          await readJsonFile<CfStructure>(cfStructurePath()),
          region,
          org,
          updatedAt,
        );
        await writeJsonFileAtomic(cfStructurePath(), nextStable);
      }

      return {
        ...readPersistedOrg(nextRuntime.structure, region, org.name),
        metadata: toSyncMetadata(nextRuntime),
      };
    }

    const nextStable = mergeOrgIntoStructure(
      await readJsonFile<CfStructure>(cfStructurePath()),
      region,
      org,
      updatedAt,
    );
    await writeJsonFileAtomic(cfStructurePath(), nextStable);
    return readPersistedOrg(nextStable, region, org.name);
  });
}
