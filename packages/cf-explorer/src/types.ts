export const EXPLORER_ERROR_CODES = [
  "MISSING_CREDENTIALS",
  "UNKNOWN_REGION",
  "CF_LOGIN_FAILED",
  "CF_TARGET_FAILED",
  "APP_NOT_FOUND",
  "SSH_DISABLED",
  "INSTANCE_NOT_FOUND",
  "UNSAFE_INPUT",
  "OUTPUT_LIMIT_EXCEEDED",
  "REMOTE_COMMAND_FAILED",
  "LIFECYCLE_CONFIRMATION_REQUIRED",
  "SESSION_NOT_FOUND",
  "SESSION_STALE",
  "SESSION_BUSY",
  "BROKER_UNAVAILABLE",
  "IPC_FAILED",
  "SESSION_PROTOCOL_ERROR",
  "SESSION_HANDSHAKE_FAILED",
  "SESSION_RECOVERY_FAILED",
  "ABORTED",
] as const;

export type ExplorerErrorCode = (typeof EXPLORER_ERROR_CODES)[number];

export interface ExplorerTarget {
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
  readonly apiEndpoint?: string;
}

export interface ExplorerCredentials {
  readonly email: string;
  readonly password: string;
}

export interface ExplorerRuntimeOptions {
  readonly cfBin?: string;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly credentials?: ExplorerCredentials;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

export interface InstanceSelector {
  readonly process?: string;
  readonly instance?: number;
  readonly allInstances?: boolean;
}

export interface ExplorerMeta {
  readonly target: ExplorerTarget;
  readonly process: string;
  readonly instance?: number;
  readonly durationMs: number;
  readonly truncated: boolean;
}

export interface InstanceInfo {
  readonly index: number;
  readonly state: string;
  readonly since?: string;
}

export interface InstanceFailure {
  readonly instance: number;
  readonly durationMs: number;
  readonly error: {
    readonly code: ExplorerErrorCode;
    readonly message: string;
  };
}

export interface InstanceResult<T> {
  readonly instance: number;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly result?: T;
  readonly error?: {
    readonly code: ExplorerErrorCode;
    readonly message: string;
  };
}

export interface RootsResult {
  readonly meta: ExplorerMeta;
  readonly roots: readonly string[];
  readonly instances?: readonly InstanceResult<Pick<RootsResult, "roots">>[];
}

export interface InstancesResult {
  readonly meta: ExplorerMeta;
  readonly instances: readonly InstanceInfo[];
}

export interface FindMatch {
  readonly instance: number;
  readonly path: string;
  readonly kind: "file" | "directory";
}

export interface LsEntry {
  readonly instance: number;
  readonly path: string;
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
}

export interface LsResult {
  readonly meta: ExplorerMeta;
  readonly path: string;
  readonly entries: readonly LsEntry[];
  readonly instances?: readonly InstanceResult<Pick<LsResult, "entries" | "path">>[];
}

export interface FindResult {
  readonly meta: ExplorerMeta;
  readonly matches: readonly FindMatch[];
  readonly instances?: readonly InstanceResult<Pick<FindResult, "matches">>[];
}

export interface GrepMatch {
  readonly instance: number;
  readonly path: string;
  readonly line: number;
  readonly preview?: string;
}

export interface GrepResult {
  readonly meta: ExplorerMeta;
  readonly matches: readonly GrepMatch[];
  readonly instances?: readonly InstanceResult<Pick<GrepResult, "matches">>[];
}

export interface ViewLine {
  readonly line: number;
  readonly text: string;
}

export interface ViewResult {
  readonly meta: ExplorerMeta;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly lines: readonly ViewLine[];
}

export interface SuggestedBreakpoint {
  readonly instance: number;
  readonly bp: string;
  readonly remoteRoot: string;
  readonly line: number;
  readonly confidence: "high" | "medium" | "low";
  readonly reason: string;
}

export interface InspectCandidatesResult {
  readonly meta: ExplorerMeta;
  readonly roots: readonly string[];
  readonly files: readonly FindMatch[];
  readonly contentMatches: readonly GrepMatch[];
  readonly suggestedBreakpoints: readonly SuggestedBreakpoint[];
  readonly instances?: readonly InstanceResult<
    Pick<InspectCandidatesResult, "contentMatches" | "files" | "roots" | "suggestedBreakpoints">
  >[];
}

export interface LifecycleResult {
  readonly meta: ExplorerMeta;
  readonly changed: boolean;
  readonly status: string;
  readonly message: string;
}

export interface DiscoveryOptions extends InstanceSelector {
  readonly target: ExplorerTarget;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly runtime?: ExplorerRuntimeOptions;
}

export interface FindOptions extends DiscoveryOptions {
  readonly root: string;
  readonly name: string;
}

export interface LsOptions extends DiscoveryOptions {
  readonly path: string;
}

export interface GrepOptions extends DiscoveryOptions {
  readonly root: string;
  readonly text: string;
  readonly preview?: boolean;
}

export interface ViewOptions extends DiscoveryOptions {
  readonly file: string;
  readonly line: number;
  readonly context?: number;
}

export interface InspectCandidatesOptions extends DiscoveryOptions {
  readonly text: string;
  readonly root?: string;
  readonly name?: string;
}

export interface LifecycleOptions extends InstanceSelector {
  readonly target: ExplorerTarget;
  readonly confirmImpact?: boolean;
  readonly runtime?: ExplorerRuntimeOptions;
}

export const SESSION_STATUSES = [
  "starting",
  "ready",
  "busy",
  "stopping",
  "stopped",
  "stale",
  "error",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface SessionTarget extends ExplorerTarget {
  readonly process: string;
  readonly instance: number;
}

export interface ExplorerSessionRecord {
  readonly sessionId: string;
  readonly brokerPid: number;
  readonly sshPid?: number;
  readonly hostname: string;
  readonly socketPath: string;
  readonly target: ExplorerTarget;
  readonly process: string;
  readonly instance: number;
  readonly cfHomeDir: string;
  readonly startedAt: string;
  readonly lastUsedAt: string;
  readonly status: SessionStatus;
  readonly message?: string;
}

export interface SessionListResult {
  readonly sessions: readonly ExplorerSessionRecord[];
}

export interface SessionStatusResult {
  readonly sessionId: string;
  readonly target: ExplorerTarget;
  readonly process: string;
  readonly instance: number;
  readonly brokerAlive: boolean;
  readonly sshAlive: boolean;
  readonly socketAlive: boolean;
  readonly status: SessionStatus;
  readonly message?: string;
}

export interface StartSessionOptions extends InstanceSelector {
  readonly target: ExplorerTarget;
  readonly runtime?: ExplorerRuntimeOptions;
  readonly idleTimeoutMs?: number;
  readonly maxLifetimeMs?: number;
  readonly sessionIdFactory?: () => string;
}

export interface StopSessionOptions {
  readonly sessionId?: string;
  readonly all?: boolean;
  readonly runtime?: ExplorerRuntimeOptions;
}

export interface StopSessionResult {
  readonly stopped: number;
}

export type AttachedDiscoveryOptions = Omit<
  DiscoveryOptions,
  "allInstances" | "instance" | "process" | "runtime" | "target"
>;
export type AttachedFindOptions = Omit<
  FindOptions,
  "allInstances" | "instance" | "process" | "runtime" | "target"
>;
export type AttachedLsOptions = Omit<
  LsOptions,
  "allInstances" | "instance" | "process" | "runtime" | "target"
>;
export type AttachedGrepOptions = Omit<
  GrepOptions,
  "allInstances" | "instance" | "process" | "runtime" | "target"
>;
export type AttachedViewOptions = Omit<
  ViewOptions,
  "allInstances" | "instance" | "process" | "runtime" | "target"
>;
export type AttachedInspectCandidatesOptions = Omit<
  InspectCandidatesOptions,
  "allInstances" | "instance" | "process" | "runtime" | "target"
>;

export interface AttachedExplorerSession {
  readonly session: ExplorerSessionRecord;
  roots(options?: AttachedDiscoveryOptions): Promise<RootsResult>;
  ls(options: AttachedLsOptions): Promise<LsResult>;
  find(options: AttachedFindOptions): Promise<FindResult>;
  grep(options: AttachedGrepOptions): Promise<GrepResult>;
  view(options: AttachedViewOptions): Promise<ViewResult>;
  inspectCandidates(
    options: AttachedInspectCandidatesOptions,
  ): Promise<InspectCandidatesResult>;
  stop(): Promise<void>;
}

export interface Explorer {
  roots(options?: Omit<DiscoveryOptions, "runtime" | "target">): Promise<RootsResult>;
  instances(options?: Omit<DiscoveryOptions, "runtime" | "target">): Promise<InstancesResult>;
  ls(options: Omit<LsOptions, "runtime" | "target">): Promise<LsResult>;
  find(options: Omit<FindOptions, "runtime" | "target">): Promise<FindResult>;
  grep(options: Omit<GrepOptions, "runtime" | "target">): Promise<GrepResult>;
  view(options: Omit<ViewOptions, "runtime" | "target">): Promise<ViewResult>;
  inspectCandidates(
    options: Omit<InspectCandidatesOptions, "runtime" | "target">,
  ): Promise<InspectCandidatesResult>;
  sshStatus(options?: Omit<LifecycleOptions, "runtime" | "target">): Promise<LifecycleResult>;
  enableSsh(options: Omit<LifecycleOptions, "runtime" | "target">): Promise<LifecycleResult>;
  restartApp(options: Omit<LifecycleOptions, "runtime" | "target">): Promise<LifecycleResult>;
  prepareSsh(options: Omit<LifecycleOptions, "runtime" | "target">): Promise<LifecycleResult>;
  dispose(): Promise<void>;
}

export interface CreateExplorerOptions extends ExplorerRuntimeOptions {
  readonly target: ExplorerTarget;
  readonly process?: string;
}
