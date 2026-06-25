export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const STREAM_STATE_STATUSES = [
  "starting",
  "streaming",
  "reconnecting",
  "stopped",
  "error",
] as const;

export type StreamStateStatus = (typeof STREAM_STATE_STATUSES)[number];

export interface CfTarget {
  readonly apiEndpoint?: string;
  readonly region?: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
}

export interface CfSessionInput {
  readonly apiEndpoint?: string;
  readonly region?: string;
  readonly email: string;
  readonly password: string;
  readonly org: string;
  readonly space: string;
  readonly cfHomeDir?: string;
  readonly command?: string;
}

export interface AppCatalogEntry {
  readonly name: string;
  readonly runningInstances: number;
}

export interface ParsedLogRow {
  readonly id: number;
  readonly timestamp: string;
  readonly timestampRaw: string;
  readonly source: string;
  readonly stream: "OUT" | "ERR";
  readonly format: "text" | "json";
  readonly level: LogLevel;
  readonly logger: string;
  readonly component: string;
  readonly org: string;
  readonly space: string;
  readonly host: string;
  readonly method: string;
  readonly request: string;
  readonly status: string;
  readonly latency: string;
  readonly tenant: string;
  readonly clientIp: string;
  readonly requestId: string;
  readonly message: string;
  readonly rawBody: string;
  readonly jsonPayload: Record<string, unknown> | null;
  readonly searchableText: string;
}

export interface ParseLogsOptions {
  readonly logLimit?: number;
}

export interface FilterRowsOptions {
  readonly level?: LogLevel | "all";
  readonly searchTerm?: string;
  readonly newestFirst?: boolean;
}

export interface LogSnapshot {
  readonly appName: string;
  readonly rawText: string;
  readonly rows: readonly ParsedLogRow[];
  readonly fetchedAt: string;
  readonly truncated: boolean;
}

export interface RuntimeStreamState {
  readonly status: StreamStateStatus;
  readonly message?: string;
  readonly updatedAt: string;
}

export interface RuntimeAppState {
  readonly appName: string;
  readonly runningInstances: number;
  readonly rawText: string;
  readonly rows: readonly ParsedLogRow[];
  readonly updatedAt?: string;
  readonly streamState?: RuntimeStreamState;
}

export interface LogStoreKey {
  readonly apiEndpoint: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
}

export interface LogStoreEntry {
  readonly key: LogStoreKey;
  readonly rawText: string;
  readonly fetchedAt: string;
  readonly updatedAt: string;
  readonly rowCount: number;
  readonly truncated: boolean;
}

export interface LogStore {
  readonly version: 1;
  readonly entries: readonly LogStoreEntry[];
}

export interface PersistSnapshotInput {
  readonly key: LogStoreKey;
  readonly rawText: string;
  readonly rows: readonly ParsedLogRow[];
  readonly fetchedAt?: string;
  readonly logLimit?: number;
  readonly storePath?: string;
}

export interface FetchRecentLogsInput extends CfSessionInput {
  readonly app: string;
}

export interface FetchRecentLogsFromTargetInput {
  readonly appName: string;
  readonly cfHomeDir?: string;
  readonly command?: string;
}

export interface CompactLogRowRef {
  readonly rowId: number;
  readonly ref: string;
}

export interface CompactLogOptions {
  readonly messageLimit?: number;
  readonly refs?: readonly CompactLogRowRef[];
}

export interface CompactLogRow {
  readonly id: number;
  readonly time: string;
  readonly level: LogLevel;
  readonly source: string;
  readonly stream?: "OUT" | "ERR";
  readonly logger?: string;
  readonly message?: string;
  readonly request?: string;
  readonly status?: string;
  readonly latency?: string;
  readonly tenant?: string;
  readonly clientIp?: string;
  readonly requestId?: string;
  readonly ref?: string;
}

export interface CompactLogSummary {
  readonly firstTimestamp: string;
  readonly lastTimestamp: string;
  readonly levels: Readonly<Record<string, number>>;
  readonly sources: Readonly<Record<string, number>>;
  readonly formats: Readonly<Record<string, number>>;
}

export interface CompactLogDocumentInput {
  readonly appName?: string;
  readonly generatedAt?: string;
  readonly truncated?: boolean;
  readonly rows: readonly ParsedLogRow[];
  readonly refs?: readonly CompactLogRowRef[];
}

export interface CompactLogDocument {
  readonly appName?: string;
  readonly generatedAt?: string;
  readonly truncated: boolean;
  readonly rowCount: number;
  readonly summary: CompactLogSummary;
  readonly rows: readonly CompactLogRow[];
}

export interface CompactSessionTarget {
  readonly apiEndpoint: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
}

export interface CompactSession {
  readonly version: 1;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly ttlMinutes: number;
  readonly target?: CompactSessionTarget;
  readonly rows: readonly ParsedLogRow[];
}

export interface CompactSessionSummary {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly ttlMinutes: number;
  readonly rowCount: number;
  readonly target?: CompactSessionTarget;
}

export interface CompactSessionRef {
  readonly sessionId: string;
  readonly rowId: number;
}

export interface CompactSessionRowLookup {
  readonly ref: string;
  readonly session: CompactSession;
  readonly row: ParsedLogRow;
}

export type PrepareCfCliSessionInput = CfSessionInput;

export interface StartedAppRow {
  readonly name: string;
  readonly requestedState: string;
  readonly runningInstances: number;
}

export interface LogStreamStartInput {
  readonly appName: string;
  readonly cfHomeDir?: string;
  readonly command?: string;
}

export interface LogStreamReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
}

export interface LogStreamProcess {
  readonly stdout: LogStreamReadable;
  readonly stderr: LogStreamReadable;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export interface LogStreamHandle {
  stop(): void;
  readonly process: LogStreamProcess;
}

export interface RuntimeEvent {
  readonly type: "snapshot" | "append" | "stream-state";
  readonly appName: string;
}

export interface SnapshotRuntimeEvent extends RuntimeEvent {
  readonly type: "snapshot";
  readonly snapshot: LogSnapshot;
}

export interface AppendRuntimeEvent extends RuntimeEvent {
  readonly type: "append";
  readonly lines: readonly string[];
  readonly state: RuntimeAppState;
}

export interface StreamStateRuntimeEvent extends RuntimeEvent {
  readonly type: "stream-state";
  readonly streamState: RuntimeStreamState;
}

export type CfLogsRuntimeEvent =
  | SnapshotRuntimeEvent
  | AppendRuntimeEvent
  | StreamStateRuntimeEvent;

export interface RuntimeDependencies {
  readonly prepareSession?: (input: PrepareCfCliSessionInput) => Promise<void>;
  readonly fetchRecentLogsFromTarget?: (
    input: FetchRecentLogsFromTargetInput,
  ) => Promise<string>;
  readonly spawnLogStreamFromTarget?: (
    input: LogStreamStartInput,
  ) => LogStreamHandle;
  readonly persistSnapshot?: (input: PersistSnapshotInput) => Promise<LogStoreEntry>;
}

export interface CfLogsRuntimeOptions {
  readonly logLimit?: number;
  readonly persistSnapshots?: boolean;
  readonly persistStreamAppends?: boolean;
  readonly retryInitialMs?: number;
  readonly retryMaxMs?: number;
  readonly flushIntervalMs?: number;
  readonly now?: () => Date;
}
