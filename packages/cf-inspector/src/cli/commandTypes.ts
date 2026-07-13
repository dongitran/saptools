export const DEFAULT_BREAKPOINT_TIMEOUT_SEC = 30;
export const DEFAULT_CF_TIMEOUT_SEC = 180;
export const DEFAULT_EXCEPTION_TIMEOUT_SEC = 30;

export interface PortTarget {
  readonly kind: "port";
  readonly port: number;
  readonly host: string;
  readonly targetIndex?: number;
}

export interface CfTarget {
  readonly kind: "cf";
  readonly region: string;
  readonly apiEndpoint?: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
  readonly tunnelTimeoutMs: number;
  readonly targetIndex?: number;
}

export type Target = PortTarget | CfTarget;

export interface SharedTargetOptions {
  readonly port?: string;
  readonly host?: string;
  readonly region?: string;
  readonly apiEndpoint?: string;
  readonly org?: string;
  readonly space?: string;
  readonly app?: string;
  readonly timeout?: string;
  readonly target?: string;
}

export interface SnapshotCommandOptions extends SharedTargetOptions {
  readonly bp: readonly string[];
  readonly capture?: string;
  readonly setupEval?: readonly string[];
  readonly timeout?: string;
  readonly remoteRoot?: string;
  readonly condition?: string;
  readonly hitCount?: string;
  readonly stackDepth?: string;
  readonly stackCaptures?: string;
  readonly maxValueLength?: string;
  readonly json: boolean;
  readonly keepPaused?: boolean;
  readonly failOnUnmatchedPause?: boolean;
  readonly includeScopes?: boolean;
  readonly quiet?: boolean;
  readonly allowMutation?: boolean;
}

export interface EvalCommandOptions extends SharedTargetOptions {
  readonly expr: string;
  readonly json: boolean;
}

export interface ListScriptsCommandOptions extends SharedTargetOptions {
  readonly filter?: string;
  readonly json: boolean;
}

export interface ListTargetsCommandOptions extends SharedTargetOptions {
  readonly json: boolean;
}

export interface LogCommandOptions extends SharedTargetOptions {
  readonly at: string;
  readonly expr: string;
  readonly remoteRoot?: string;
  readonly duration?: string;
  readonly maxEvents?: string;
  readonly hitCount?: string;
  readonly condition?: string;
  readonly json: boolean;
}

export interface AttachCommandOptions extends SharedTargetOptions {
  readonly json: boolean;
}

export interface WatchCommandOptions extends SharedTargetOptions {
  readonly bp: readonly string[];
  readonly capture?: string;
  readonly setupEval?: readonly string[];
  readonly condition?: string;
  readonly hitCount?: string;
  readonly remoteRoot?: string;
  readonly duration?: string;
  readonly maxEvents?: string;
  readonly timeout?: string;
  readonly maxValueLength?: string;
  readonly stackDepth?: string;
  readonly stackCaptures?: string;
  readonly includeScopes?: boolean;
  readonly json: boolean;
  readonly allowMutation?: boolean;
}

export interface ExceptionCommandOptions extends SharedTargetOptions {
  readonly type?: string;
  readonly capture?: string;
  readonly stackDepth?: string;
  readonly stackCaptures?: string;
  readonly remoteRoot?: string;
  readonly timeout?: string;
  readonly maxValueLength?: string;
  readonly includeScopes?: boolean;
  readonly keepPaused?: boolean;
  readonly json: boolean;
  readonly allowMutation?: boolean;
}
