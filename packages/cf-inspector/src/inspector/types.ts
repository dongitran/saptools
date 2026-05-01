import type { CdpClient } from "../cdp/client.js";
import type {
  BreakpointLocation,
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
  lastResumedAtMs?: number;
}

export interface InspectorSession {
  readonly client: CdpClient;
  readonly target: InspectorTarget;
  readonly scripts: ReadonlyMap<string, ScriptInfo>;
  readonly pauseBuffer: PauseEvent[];
  readonly pauseWaitGate: PauseWaitGate;
  readonly debuggerState: DebuggerState;
  dispose(): Promise<void>;
}

export interface CdpCallFrame {
  callFrameId?: unknown;
  functionName?: unknown;
  location?: { lineNumber?: unknown; columnNumber?: unknown };
  url?: unknown;
  scopeChain?: unknown;
}

export interface CdpScope {
  type?: unknown;
  name?: unknown;
  object?: { objectId?: unknown };
}

export interface CdpPauseParams {
  reason?: unknown;
  hitBreakpoints?: unknown;
  callFrames?: unknown;
}

export interface CdpSetBreakpointResult {
  breakpointId?: unknown;
  locations?: unknown;
}

export interface CdpResolvedLocation {
  scriptId?: unknown;
  lineNumber?: unknown;
  columnNumber?: unknown;
  url?: unknown;
}

export interface CdpEvalResult {
  result?: { type?: unknown; value?: unknown; description?: unknown; objectId?: unknown };
  exceptionDetails?: { text?: unknown; exception?: { description?: unknown } };
}

export interface CdpProperty {
  name?: unknown;
  value?: { type?: unknown; value?: unknown; description?: unknown; objectId?: unknown };
}

export interface ScriptParsedParams {
  scriptId?: unknown;
  url?: unknown;
}

export interface SetBreakpointInput extends BreakpointLocation {
  readonly remoteRoot?: RemoteRootSetting;
  readonly condition?: string;
}

export interface WaitForPauseOptions {
  readonly timeoutMs: number;
  readonly breakpointIds?: readonly string[];
  readonly unmatchedPausePolicy?: "wait-for-resume" | "fail";
  readonly onUnmatchedPause?: (pause: PauseEvent) => void;
}

export type { InspectorTarget } from "./discovery.js";
