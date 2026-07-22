import type { CdpClient } from "../cdp/client.js";
import type {
  BreakpointLocation,
  InspectorIsolate,
  PauseEvent,
  RemoteRootSetting,
  ScriptInfo,
} from "../types.js";

import type { InspectorTarget } from "./discovery.js";

/**
 * Internal coordination flag between the always-on `Debugger.paused` buffer in
 * `connectInspector` and an active `waitForPause`. When `active` is true, the
 * buffer listener skips pushing the live event so it cannot be replayed by a
 * subsequent `waitForPause` call.
 */
export interface PauseWaitGate {
  active: boolean;
}

export interface DebuggerState {
  currentPause?: PauseEvent;
  lastResumedAtMs?: number;
  paused?: boolean;
}

export interface InspectorSession {
  readonly client: CdpClient;
  readonly target: InspectorTarget;
  readonly scripts: ReadonlyMap<string, ScriptInfo>;
  readonly pauseBuffer: PauseEvent[];
  readonly pauseWaitGate: PauseWaitGate;
  readonly debuggerState: DebuggerState;
  readonly isolate?: InspectorIsolate;
  readonly targetIndex?: number;
  readonly targetCount?: number;
  readonly workerIndex?: number;
  readonly workerTargets?: readonly InspectorWorkerTarget[];
  readonly workerDiscoverySupported?: boolean;
  dispose(): Promise<void>;
}

export interface InspectorSessionGroup {
  readonly targetIndex: number;
  readonly targetCount: number;
  readonly workerDiscoverySupported: boolean;
  list(): readonly InspectorSession[];
  onSession(listener: (session: InspectorSession) => void): () => void;
  onSessionRemoved(listener: (session: InspectorSession) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  dispose(): Promise<void>;
}

export interface InspectorWorkerTarget {
  readonly sessionId: string;
  readonly workerId: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
}

export interface CdpCallFrame {
  callFrameId?: unknown;
  functionName?: unknown;
  functionLocation?: CdpLocation;
  location?: CdpLocation;
  url?: unknown;
  scopeChain?: unknown;
  this?: unknown;
  returnValue?: unknown;
}

export interface CdpLocation {
  scriptId?: unknown;
  lineNumber?: unknown;
  columnNumber?: unknown;
}

export interface CdpScope {
  type?: unknown;
  name?: unknown;
  object?: unknown;
  startLocation?: CdpLocation;
  endLocation?: CdpLocation;
}

export interface CdpPauseParams {
  reason?: unknown;
  hitBreakpoints?: unknown;
  callFrames?: unknown;
  data?: unknown;
  asyncStackTrace?: unknown;
  asyncStackTraceId?: unknown;
  asyncCallStackTraceId?: unknown;
}

export interface CdpSetBreakpointResult {
  breakpointId?: unknown;
  locations?: unknown;
}

export interface CdpSetExactBreakpointResult {
  breakpointId?: unknown;
  actualLocation?: unknown;
}

export interface CdpPossibleBreakpointsResult {
  locations?: unknown;
}

export interface CdpResolvedLocation {
  scriptId?: unknown;
  lineNumber?: unknown;
  columnNumber?: unknown;
  url?: unknown;
}

export interface CdpEvalResult {
  result?: {
    type?: unknown;
    subtype?: unknown;
    className?: unknown;
    value?: unknown;
    description?: unknown;
    objectId?: unknown;
  };
  exceptionDetails?: {
    text?: unknown;
    exception?: { className?: unknown; description?: unknown };
  };
}

export interface CdpProperty {
  name?: unknown;
  value?: { type?: unknown; value?: unknown; description?: unknown; objectId?: unknown };
}

export interface ScriptParsedParams {
  scriptId?: unknown;
  url?: unknown;
  startLine?: unknown;
  startColumn?: unknown;
  endLine?: unknown;
  endColumn?: unknown;
  executionContextId?: unknown;
  hash?: unknown;
  buildId?: unknown;
  executionContextAuxData?: unknown;
  sourceMapURL?: unknown;
  hasSourceURL?: unknown;
  isModule?: unknown;
  length?: unknown;
  stackTrace?: unknown;
}

export interface SetBreakpointInput extends BreakpointLocation {
  readonly remoteRoot?: RemoteRootSetting;
  readonly condition?: string;
  readonly hitCount?: number;
}

export interface WaitForPauseOptions {
  readonly timeoutMs: number;
  readonly breakpointIds?: readonly string[];
  readonly pauseReasons?: readonly string[];
  readonly unmatchedPausePolicy?: "wait-for-resume" | "fail";
  readonly onUnmatchedPause?: (pause: PauseEvent) => void;
  readonly signal?: AbortSignal;
}

export type { InspectorTarget } from "./discovery.js";
