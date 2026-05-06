export type CfInspectorErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_BREAKPOINT"
  | "INVALID_REMOTE_ROOT"
  | "INVALID_EXPRESSION"
  | "INVALID_HIT_COUNT"
  | "INVALID_PAUSE_TYPE"
  | "BREAKPOINT_DID_NOT_BIND"
  | "INSPECTOR_DISCOVERY_FAILED"
  | "INSPECTOR_CONNECTION_FAILED"
  | "CDP_REQUEST_FAILED"
  | "BREAKPOINT_NOT_HIT"
  | "UNRELATED_PAUSE"
  | "UNRELATED_PAUSE_TIMEOUT"
  | "EVALUATION_FAILED"
  | "MISSING_TARGET"
  | "ABORTED";

export class CfInspectorError extends Error {
  public readonly code: CfInspectorErrorCode;
  public readonly detail?: string;

  public constructor(code: CfInspectorErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "CfInspectorError";
    this.code = code;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}

export interface BreakpointLocation {
  readonly file: string;
  readonly line: number;
}

export interface RemoteRootLiteral {
  readonly kind: "literal";
  readonly value: string;
}

export interface RemoteRootRegex {
  readonly kind: "regex";
  readonly pattern: string;
  readonly flags: string;
  readonly regex: RegExp;
}

export interface RemoteRootNone {
  readonly kind: "none";
}

export type RemoteRootSetting = RemoteRootLiteral | RemoteRootRegex | RemoteRootNone;

export interface BreakpointHandle {
  readonly breakpointId: string;
  readonly file: string;
  readonly line: number;
  readonly urlRegex: string;
  readonly resolvedLocations: readonly ResolvedLocation[];
}

export interface ResolvedLocation {
  readonly scriptId: string;
  readonly url?: string;
  readonly lineNumber: number;
  readonly columnNumber?: number;
}

export interface CallFrameInfo {
  readonly callFrameId: string;
  readonly functionName: string;
  readonly url?: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
  readonly scopeChain: readonly ScopeInfo[];
}

export interface ScopeInfo {
  readonly type: string;
  readonly objectId?: string;
  readonly name?: string;
}

export interface PauseEvent {
  readonly reason: string;
  readonly hitBreakpoints: readonly string[];
  readonly callFrames: readonly CallFrameInfo[];
  readonly receivedAtMs?: number;
  readonly data?: unknown;
}

export interface VariableSnapshot {
  readonly name: string;
  readonly value: string;
  readonly type?: string;
  readonly children?: readonly VariableSnapshot[];
}

export interface ScopeSnapshot {
  readonly type: string;
  readonly variables: readonly VariableSnapshot[];
}

export interface FrameSnapshot {
  readonly functionName: string;
  readonly url?: string;
  readonly line: number;
  readonly column: number;
  readonly scopes?: readonly ScopeSnapshot[];
  readonly captures?: readonly CapturedExpression[];
}

export interface CapturedExpression {
  readonly expression: string;
  readonly value?: string;
  readonly type?: string;
  readonly error?: string;
}

export interface ExceptionSnapshot {
  readonly value?: string;
  readonly type?: string;
  readonly description?: string;
  readonly error?: string;
}

export interface SnapshotCaptureResult {
  readonly reason: string;
  readonly hitBreakpoints: readonly string[];
  readonly capturedAt: string;
  readonly topFrame?: FrameSnapshot;
  readonly captures: readonly CapturedExpression[];
  readonly stack?: readonly FrameSnapshot[];
  readonly exception?: ExceptionSnapshot;
}

export interface SnapshotResult extends SnapshotCaptureResult {
  readonly pausedDurationMs: number | null;
}

export interface WatchEvent {
  readonly ts: string;
  readonly at: string;
  readonly hit: number;
  readonly reason: string;
  readonly hitBreakpoints: readonly string[];
  readonly topFrame?: FrameSnapshot;
  readonly captures: readonly CapturedExpression[];
  readonly stack?: readonly FrameSnapshot[];
  readonly exception?: ExceptionSnapshot;
}

export interface ScriptInfo {
  readonly scriptId: string;
  readonly url: string;
}

export interface InspectorConnectOptions {
  readonly port: number;
  readonly host?: string;
  readonly connectTimeoutMs?: number;
}

export type CdpMessage =
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly error: { readonly code: number; readonly message: string } }
  | { readonly method: string; readonly params: unknown };
