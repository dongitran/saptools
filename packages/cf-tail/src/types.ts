import type {
  AppCatalogEntry,
  CfSessionInput,
  FetchRecentLogsFromTargetInput,
  LogLevel,
  LogStoreEntry,
  ParsedLogRow,
  PersistSnapshotInput,
  PrepareCfCliSessionInput,
  RuntimeAppState,
  RuntimeDependencies,
  RuntimeStreamState,
} from "@saptools/cf-logs";

export interface AppFilterInput {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly includeRegex?: readonly string[];
  readonly excludeRegex?: readonly string[];
}

export interface AppFilter {
  readonly include: ReadonlySet<string>;
  readonly exclude: ReadonlySet<string>;
  readonly includeRegex: readonly RegExp[];
  readonly excludeRegex: readonly RegExp[];
}

export interface DiscoverAppsInput extends CfSessionInput, AppFilterInput {}

export interface MultiSnapshotInput extends CfSessionInput, AppFilterInput {
  readonly concurrency?: number;
  readonly logLimit?: number;
  readonly persist?: boolean;
  readonly extraSecrets?: readonly string[];
}

export interface TailLogRow extends ParsedLogRow {
  readonly appName: string;
}

export interface AppSnapshotResult {
  readonly appName: string;
  readonly rawText: string;
  readonly rows: readonly ParsedLogRow[];
  readonly fetchedAt: string;
  readonly truncated: boolean;
}

export interface AppSnapshotError {
  readonly appName: string;
  readonly error: string;
}

export interface MultiSnapshotResult {
  readonly fetchedAt: string;
  readonly apps: readonly AppSnapshotResult[];
  readonly merged: readonly TailLogRow[];
  readonly errors: readonly AppSnapshotError[];
}

export interface TailFilterOptions {
  readonly level?: LogLevel | "all";
  readonly searchTerm?: string;
  readonly source?: string;
  readonly tenant?: string;
  readonly statusMin?: number;
  readonly statusMax?: number;
  readonly stream?: "out" | "err" | "all";
  readonly sinceMs?: number;
  readonly untilMs?: number;
  readonly newestFirst?: boolean;
  readonly maxRows?: number;
  readonly apps?: readonly string[];
}

export interface TailLevelSummary {
  readonly trace: number;
  readonly debug: number;
  readonly info: number;
  readonly warn: number;
  readonly error: number;
  readonly fatal: number;
}

export interface TailAppSummary {
  readonly appName: string;
  readonly total: number;
  readonly levels: TailLevelSummary;
  readonly sources: ReadonlyMap<string, number>;
  readonly statusBuckets: ReadonlyMap<string, number>;
  readonly tenants: ReadonlyMap<string, number>;
  readonly firstAt: string | undefined;
  readonly lastAt: string | undefined;
}

export interface TailSummary {
  readonly total: number;
  readonly levels: TailLevelSummary;
  readonly apps: readonly TailAppSummary[];
}

export interface FormatRowOptions {
  readonly color?: boolean;
  readonly appNamePadding?: number;
  readonly showSource?: boolean;
  readonly showRequestMeta?: boolean;
  readonly truncateMessage?: number;
}

export interface CfTailRuntimeOptions {
  readonly logLimit?: number;
  readonly flushIntervalMs?: number;
  readonly retryInitialMs?: number;
  readonly retryMaxMs?: number;
  readonly extraSecrets?: readonly string[];
  readonly rediscoverIntervalMs?: number;
  readonly persistStreamAppends?: boolean;
  readonly now?: () => Date;
}

export interface SnapshotDependencies {
  readonly prepareSession?: (input: PrepareCfCliSessionInput) => Promise<void>;
  readonly fetchRecentLogsFromTarget?: (input: FetchRecentLogsFromTargetInput) => Promise<string>;
  readonly persistSnapshot?: (input: PersistSnapshotInput) => Promise<LogStoreEntry>;
}

export interface CfTailRuntimeDependencies extends RuntimeDependencies {
  readonly discoverApps?: (input: CfSessionInput & AppFilterInput) => Promise<readonly AppCatalogEntry[]>;
}

export interface DiscoveryEvent {
  readonly type: "discovery";
  readonly apps: readonly AppCatalogEntry[];
  readonly addedApps: readonly string[];
  readonly removedApps: readonly string[];
  readonly initial: boolean;
  readonly changed: boolean;
  readonly at: string;
}

export interface LinesEvent {
  readonly type: "lines";
  readonly appName: string;
  readonly lines: readonly string[];
  readonly rows: readonly TailLogRow[];
  readonly state: RuntimeAppState;
}

export interface StreamStateEvent {
  readonly type: "stream-state";
  readonly appName: string;
  readonly streamState: RuntimeStreamState;
}

export interface DiscoveryErrorEvent {
  readonly type: "discovery-error";
  readonly message: string;
  readonly at: string;
}

export type CfTailEvent =
  | DiscoveryEvent
  | LinesEvent
  | StreamStateEvent
  | DiscoveryErrorEvent;

export interface TailStoreKey {
  readonly apiEndpoint: string;
  readonly org: string;
  readonly space: string;
}

export interface TailStoreEntry {
  readonly key: TailStoreKey;
  readonly fetchedAt: string;
  readonly updatedAt: string;
  readonly appCount: number;
  readonly rowCount: number;
  readonly apps: readonly {
    readonly appName: string;
    readonly rowCount: number;
    readonly truncated: boolean;
  }[];
}

export interface TailStore {
  readonly version: 1;
  readonly entries: readonly TailStoreEntry[];
}
