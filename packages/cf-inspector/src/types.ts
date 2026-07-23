export type CfInspectorErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_BREAKPOINT"
  | "INVALID_REMOTE_ROOT"
  | "INVALID_EXPRESSION"
  | "MUTATION_NOT_ALLOWED"
  | "SETUP_EVAL_FAILED"
  | "INVALID_HIT_COUNT"
  | "INVALID_PAUSE_TYPE"
  | "BREAKPOINT_DID_NOT_BIND"
  | "INSPECTOR_DISCOVERY_FAILED"
  | "INSPECTOR_CONNECTION_FAILED"
  | "TARGET_ALREADY_DEBUGGED"
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

export interface ScriptLocation {
  readonly scriptId: string;
  readonly lineNumber: number;
  readonly columnNumber?: number;
}

export interface BreakLocation extends ScriptLocation {
  readonly type?: string;
}

export interface ResolvedLocation extends ScriptLocation {
  readonly url?: string;
}

export interface GetPossibleBreakpointsOptions {
  readonly start: ScriptLocation;
  readonly end?: ScriptLocation;
  readonly restrictToFunction?: boolean;
}

export interface SetBreakpointAtLocationInput {
  readonly location: ScriptLocation;
  readonly condition?: string;
}

export interface ExactBreakpointHandle {
  readonly breakpointId: string;
  readonly requestedLocation: ScriptLocation;
  readonly actualLocation: ScriptLocation;
}

export interface RemoteObjectInfo {
  readonly type: string;
  readonly subtype?: string;
  readonly className?: string;
  readonly completeness?: "truncated" | "unavailable";
  readonly value?: unknown;
  readonly unserializableValue?: string;
  readonly description?: string;
  readonly deepSerializedValue?: unknown;
  readonly objectId?: string;
  readonly preview?: unknown;
  readonly customPreview?: unknown;
}

export interface StackTraceIdInfo {
  readonly id: string;
  readonly debuggerId?: string;
}

export interface StackTraceFrameInfo {
  readonly functionName: string;
  readonly scriptId: string;
  readonly url: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
}

export interface StackTraceInfo {
  readonly description?: string;
  readonly callFrames: readonly StackTraceFrameInfo[];
  readonly parent?: StackTraceInfo;
  readonly parentId?: StackTraceIdInfo;
}

export interface CallFrameInfo {
  readonly callFrameId: string;
  readonly functionName: string;
  readonly scriptId?: string;
  readonly functionLocation?: ScriptLocation;
  readonly url?: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
  readonly scopeChain: readonly ScopeInfo[];
  readonly thisObject?: RemoteObjectInfo;
  readonly returnValue?: RemoteObjectInfo;
}

export interface ScopeInfo {
  readonly type: string;
  readonly objectId?: string;
  readonly object?: RemoteObjectInfo;
  readonly name?: string;
  readonly startLocation?: ScriptLocation;
  readonly endLocation?: ScriptLocation;
}

export interface PauseEvent {
  readonly reason: string;
  readonly hitBreakpoints: readonly string[];
  readonly callFrames: readonly CallFrameInfo[];
  readonly receivedAtMs?: number;
  readonly data?: unknown;
  readonly asyncStackTrace?: StackTraceInfo;
  readonly asyncStackTraceId?: StackTraceIdInfo;
  readonly asyncCallStackTraceId?: StackTraceIdInfo;
}

export interface VariableSnapshot {
  readonly name: string;
  readonly value: string;
  readonly type?: string;
  readonly children?: readonly VariableSnapshot[];
  readonly truncated?: true;
  readonly originalLength?: number;
  readonly omittedCount?: number;
}

export interface ScopeSnapshot {
  readonly type: string;
  readonly variables: readonly VariableSnapshot[];
  readonly truncated?: true;
  readonly omittedCount?: number;
}

export interface FrameSnapshot {
  readonly functionName: string;
  readonly url?: string;
  readonly line: number;
  readonly column: number;
  readonly scopes?: readonly ScopeSnapshot[];
  readonly captures?: readonly CapturedExpression[];
  readonly truncated?: true;
  readonly omittedCount?: number;
}

export interface CapturedExpression {
  readonly expression: string;
  readonly value?: string;
  readonly type?: string;
  readonly error?: string;
  readonly mutationRisk?: boolean;
  readonly blocked?: true;
  readonly truncated?: true;
  readonly originalLength?: number;
  readonly omittedCount?: number;
}

export interface ExceptionSnapshot {
  readonly value?: string;
  readonly type?: string;
  readonly description?: string;
  readonly error?: string;
  readonly truncated?: true;
  readonly originalLength?: number;
  readonly valueOriginalLength?: number;
  readonly descriptionOriginalLength?: number;
  readonly omittedCount?: number;
}

export interface SnapshotCaptureResult {
  readonly reason: string;
  readonly hitBreakpoints: readonly string[];
  readonly capturedAt: string;
  readonly topFrame?: FrameSnapshot;
  readonly captures: readonly CapturedExpression[];
  readonly stack?: readonly FrameSnapshot[];
  readonly exception?: ExceptionSnapshot;
  readonly isolate?: InspectorIsolate;
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
  readonly isolate?: InspectorIsolate;
}

export type InspectorIsolate =
  | { readonly kind: "main" }
  | { readonly kind: "worker"; readonly workerId: string };

export interface ScriptInfo {
  readonly scriptId: string;
  readonly url: string;
  readonly startLine?: number;
  readonly startColumn?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly executionContextId?: number;
  readonly hash?: string;
  readonly buildId?: string;
  readonly executionContextAuxData?: unknown;
  readonly sourceMapURL?: string;
  readonly hasSourceURL?: boolean;
  readonly isModule?: boolean;
  readonly length?: number;
  readonly stackTrace?: StackTraceInfo;
}

export interface InspectorConnectOptions {
  readonly port: number;
  readonly host?: string;
  readonly connectTimeoutMs?: number;
  readonly targetIndex?: number;
  readonly workerIndex?: number;
  readonly workerId?: string;
}

export type CdpMessage =
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly error: { readonly code: number; readonly message: string } }
  | { readonly method: string; readonly params: unknown };
