export const REGION_KEYS = [
  "ae01",
  "ap01",
  "ap10",
  "ap11",
  "ap12",
  "ap20",
  "ap21",
  "ap30",
  "br10",
  "br20",
  "br30",
  "ca10",
  "ca20",
  "ch20",
  "cn20",
  "cn40",
  "eu01",
  "eu02",
  "eu10",
  "eu10-002",
  "eu10-003",
  "eu10-004",
  "eu10-005",
  "eu11",
  "eu13",
  "eu20",
  "eu20-001",
  "eu20-002",
  "eu22",
  "eu30",
  "il30",
  "in30",
  "jp01",
  "jp10",
  "jp20",
  "jp30",
  "jp31",
  "sa30",
  "sa31",
  "uk20",
  "us01",
  "us02",
  "us10",
  "us10-001",
  "us10-002",
  "us11",
  "us20",
  "us21",
  "us30",
] as const;

export type RegionKey = (typeof REGION_KEYS)[number];

export interface Region {
  readonly key: RegionKey;
  readonly label: string;
  readonly apiEndpoint: string;
}

export interface AppNode {
  readonly name: string;
  readonly requestedState?: string;
  readonly runningInstances?: number;
  readonly totalInstances?: number;
  readonly routes?: readonly string[];
}

export interface SpaceNode {
  readonly name: string;
  readonly apps: readonly AppNode[];
  readonly error?: string;
}

export interface OrgNode {
  readonly name: string;
  readonly spaces: readonly SpaceNode[];
  readonly error?: string;
}

export interface RegionNode {
  readonly key: RegionKey;
  readonly label: string;
  readonly apiEndpoint: string;
  readonly accessible: boolean;
  readonly orgs: readonly OrgNode[];
  readonly error?: string;
}

export interface CfStructure {
  readonly syncedAt: string;
  readonly regions: readonly RegionNode[];
}

export type SyncStatus = "running" | "completed" | "failed";

export interface SyncMetadata {
  readonly syncId: string;
  readonly status: SyncStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly requestedRegionKeys: readonly RegionKey[];
  readonly completedRegionKeys: readonly RegionKey[];
  readonly pendingRegionKeys: readonly RegionKey[];
  readonly finishedAt?: string;
  readonly error?: string;
}

export interface RuntimeSyncState {
  readonly syncId: string;
  readonly status: SyncStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly requestedRegionKeys: readonly RegionKey[];
  readonly completedRegionKeys: readonly RegionKey[];
  readonly finishedAt?: string;
  readonly error?: string;
  readonly structure: CfStructure;
}

export interface SyncHistoryEntry {
  readonly at: string;
  readonly syncId: string;
  readonly pid: number;
  readonly hostname: string;
  readonly event: string;
  readonly status?: SyncStatus;
  readonly requestedRegionKeys?: readonly RegionKey[];
  readonly completedRegionKeys?: readonly RegionKey[];
  readonly regionKey?: RegionKey;
  readonly orgName?: string;
  readonly spaceName?: string;
  readonly appCount?: number;
  readonly orgCount?: number;
  readonly message?: string;
  readonly reason?: string;
  readonly lockSyncId?: string;
  readonly error?: string;
}

export interface StructureView {
  readonly source: "runtime" | "stable";
  readonly structure: CfStructure;
  readonly metadata: SyncMetadata | undefined;
}

export interface RegionView {
  readonly source: "runtime" | "stable" | "fresh";
  readonly region: RegionNode;
  readonly metadata: SyncMetadata | undefined;
}

export type RegionsViewSource = "catalog" | "stable";

export interface RegionsView {
  readonly source: RegionsViewSource;
  readonly regions: readonly Region[];
  readonly metadata: SyncMetadata | undefined;
}

export interface HanaBindingCredentials {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly password: string;
  readonly schema: string;
  readonly hdiUser: string;
  readonly hdiPassword: string;
  readonly url: string;
  readonly databaseId: string;
  readonly certificate: string;
}

export interface AppDbBinding {
  readonly kind: "hana";
  readonly credentials: HanaBindingCredentials;
  readonly name?: string;
  readonly label?: string;
  readonly plan?: string;
}

export interface AppDbSnapshot {
  readonly selector: string;
  readonly regionKey: RegionKey;
  readonly orgName: string;
  readonly spaceName: string;
  readonly appName: string;
  readonly syncedAt: string;
  readonly bindings: readonly AppDbBinding[];
  readonly error?: string;
}

export interface CfDbSnapshot {
  readonly version: 1;
  readonly syncedAt: string;
  readonly entries: readonly AppDbSnapshot[];
}

export interface RuntimeDbSyncState {
  readonly syncId: string;
  readonly status: SyncStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly requestedTargets: readonly string[];
  readonly completedTargets: readonly string[];
  readonly finishedAt?: string;
  readonly error?: string;
  readonly snapshot: CfDbSnapshot;
}

export interface DbSyncMetadata {
  readonly syncId: string;
  readonly status: SyncStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly requestedTargets: readonly string[];
  readonly completedTargets: readonly string[];
  readonly pendingTargets: readonly string[];
  readonly finishedAt?: string;
  readonly error?: string;
}

export interface DbSnapshotView {
  readonly source: "runtime" | "stable";
  readonly snapshot: CfDbSnapshot;
  readonly metadata: DbSyncMetadata | undefined;
}

export interface DbAppView {
  readonly source: "runtime" | "stable";
  readonly entry: AppDbSnapshot;
  readonly metadata: DbSyncMetadata | undefined;
}

export interface DbSyncHistoryEntry {
  readonly at: string;
  readonly syncId: string;
  readonly pid: number;
  readonly hostname: string;
  readonly event: string;
  readonly status?: SyncStatus;
  readonly selector?: string;
  readonly regionKey?: RegionKey;
  readonly orgName?: string;
  readonly spaceName?: string;
  readonly appName?: string;
  readonly requestedTargets?: readonly string[];
  readonly completedTargets?: readonly string[];
  readonly lockSyncId?: string;
  readonly reason?: string;
  readonly error?: string;
}

export interface DbSyncTarget {
  readonly selector: string;
  readonly regionKey: RegionKey;
  readonly apiEndpoint: string;
  readonly orgName: string;
  readonly spaceName: string;
  readonly appName: string;
}

export interface NamedDbTargetSelector {
  readonly type: "name";
  readonly appName: string;
}

export interface ExplicitDbTargetSelector {
  readonly type: "explicit";
  readonly selector: string;
  readonly regionKey: RegionKey;
  readonly orgName: string;
  readonly spaceName: string;
  readonly appName: string;
}

export type DbTargetSelector = NamedDbTargetSelector | ExplicitDbTargetSelector;
