export const DEFAULT_BREAKPOINT_TIMEOUT_SEC = 30;
export const DEFAULT_CF_TIMEOUT_SEC = 60;

export interface PortTarget {
  readonly kind: "port";
  readonly port: number;
  readonly host: string;
}

export interface CfTarget {
  readonly kind: "cf";
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
  readonly cfTimeoutMs: number;
}

export type Target = PortTarget | CfTarget;

export interface SharedTargetOptions {
  readonly port?: string;
  readonly host?: string;
  readonly region?: string;
  readonly org?: string;
  readonly space?: string;
  readonly app?: string;
  readonly cfTimeout?: string;
}

export interface SnapshotCommandOptions extends SharedTargetOptions {
  readonly bp: readonly string[];
  readonly capture?: string;
  readonly timeout?: string;
  readonly remoteRoot?: string;
  readonly condition?: string;
  readonly maxValueLength?: string;
  readonly json: boolean;
  readonly keepPaused?: boolean;
  readonly failOnUnmatchedPause?: boolean;
  readonly includeScopes?: boolean;
}

export interface EvalCommandOptions extends SharedTargetOptions {
  readonly expr: string;
  readonly json: boolean;
}

export interface ListScriptsCommandOptions extends SharedTargetOptions {
  readonly json: boolean;
}

export interface LogCommandOptions extends SharedTargetOptions {
  readonly at: string;
  readonly expr: string;
  readonly remoteRoot?: string;
  readonly duration?: string;
  readonly json: boolean;
}

export interface AttachCommandOptions extends SharedTargetOptions {
  readonly json: boolean;
}
