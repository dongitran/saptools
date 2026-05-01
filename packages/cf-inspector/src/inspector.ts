import { performance } from "node:perf_hooks";

import { CdpClient } from "./cdp.js";
import {
  discoverInspectorTargets,
  fetchInspectorVersion,
} from "./inspectorDiscovery.js";
import type { InspectorTarget } from "./inspectorDiscovery.js";
import { buildBreakpointUrlRegex } from "./pathMapper.js";
import { CfInspectorError } from "./types.js";
import type {
  BreakpointHandle,
  BreakpointLocation,
  CallFrameInfo,
  InspectorConnectOptions,
  PauseEvent,
  RemoteRootSetting,
  ResolvedLocation,
  ScopeInfo,
  ScriptInfo,
} from "./types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_HOST = "127.0.0.1";

export { discoverInspectorTargets, fetchInspectorVersion };
export type { InspectorTarget } from "./inspectorDiscovery.js";

/**
 * Internal coordination flag between the always-on `Debugger.paused` buffer in
 * `connectInspector` and an active `waitForPause`. When `active` is true, the
 * buffer listener skips pushing the live event so it cannot be replayed by a
 * subsequent `waitForPause` call. See `connectInspector` for the full rationale.
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

interface CdpCallFrame {
  callFrameId?: unknown;
  functionName?: unknown;
  location?: { lineNumber?: unknown; columnNumber?: unknown };
  url?: unknown;
  scopeChain?: unknown;
}

interface CdpScope {
  type?: unknown;
  name?: unknown;
  object?: { objectId?: unknown };
}

interface CdpPauseParams {
  reason?: unknown;
  hitBreakpoints?: unknown;
  callFrames?: unknown;
}

interface CdpSetBreakpointResult {
  breakpointId?: unknown;
  locations?: unknown;
}

interface CdpResolvedLocation {
  scriptId?: unknown;
  lineNumber?: unknown;
  columnNumber?: unknown;
  url?: unknown;
}

interface CdpEvalResult {
  result?: { type?: unknown; value?: unknown; description?: unknown; objectId?: unknown };
  exceptionDetails?: { text?: unknown; exception?: { description?: unknown } };
}

interface ScriptParsedParams {
  scriptId?: unknown;
  url?: unknown;
}

export async function connectInspector(options: InspectorConnectOptions): Promise<InspectorSession> {
  const host = options.host ?? DEFAULT_HOST;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const targets = await discoverInspectorTargets(host, options.port, connectTimeoutMs);
  const target = targets[0];
  if (!target) {
    throw new CfInspectorError(
      "INSPECTOR_DISCOVERY_FAILED",
      `No inspector targets available on ${host}:${options.port.toString()}`,
    );
  }
  const client = await CdpClient.connect({ url: target.webSocketDebuggerUrl });
  const scripts = new Map<string, ScriptInfo>();
  client.on("Debugger.scriptParsed", (raw) => {
    const params = raw as ScriptParsedParams;
    const scriptId = asString(params.scriptId);
    const url = asString(params.url);
    if (scriptId.length === 0) {
      return;
    }
    scripts.set(scriptId, { scriptId, url });
  });
  // Buffer Debugger.paused events from the moment Debugger.enable is sent so
  // breakpoints that fire before waitForPause attaches its listener are not lost.
  // Bounded (FIFO drop-oldest) to avoid unbounded memory growth on a tight
  // paused-then-resumed loop.
  //
  // The pauseWaitGate coordinates with waitForPause: when a waitForPause call
  // is currently consuming the live CDP stream, this listener skips the buffer
  // push so the same event isn't replayed by a subsequent waitForPause call.
  // Without the gate, a buffer-miss path (waitForPause sees an empty buffer
  // and falls through to client.waitFor) ends with both client.waitFor AND
  // this listener handling the same event — the event is returned AND queued
  // in the buffer, ready to be replayed on the next call.
  const PAUSE_BUFFER_LIMIT = 32;
  const pauseBuffer: PauseEvent[] = [];
  const pauseWaitGate: PauseWaitGate = { active: false };
  const debuggerState: DebuggerState = {};
  client.on("Debugger.paused", (raw) => {
    if (pauseWaitGate.active) {
      return;
    }
    const params = raw as CdpPauseParams;
    const event = toPauseEvent(params, performance.now());
    if (pauseBuffer.length >= PAUSE_BUFFER_LIMIT) {
      pauseBuffer.shift();
    }
    pauseBuffer.push(event);
  });
  client.on("Debugger.resumed", () => {
    debuggerState.lastResumedAtMs = performance.now();
  });
  await client.send("Runtime.enable");
  await client.send("Debugger.enable");
  return {
    client,
    target,
    scripts,
    pauseBuffer,
    pauseWaitGate,
    debuggerState,
    dispose: async (): Promise<void> => {
      try {
        await client.send("Debugger.disable");
      } catch {
        // best-effort
      }
      client.dispose();
    },
  };
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toResolvedLocations(value: unknown): readonly ResolvedLocation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): ResolvedLocation[] => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const candidate = entry as CdpResolvedLocation;
    const scriptId = asString(candidate.scriptId);
    if (scriptId.length === 0) {
      return [];
    }
    const url = typeof candidate.url === "string" ? candidate.url : undefined;
    const lineNumber = asNumber(candidate.lineNumber);
    const result: ResolvedLocation = url === undefined
      ? { scriptId, lineNumber, columnNumber: asNumber(candidate.columnNumber) }
      : { scriptId, url, lineNumber, columnNumber: asNumber(candidate.columnNumber) };
    return [result];
  });
}

export interface SetBreakpointInput extends BreakpointLocation {
  readonly remoteRoot?: RemoteRootSetting;
  readonly condition?: string;
}

export async function setBreakpoint(
  session: InspectorSession,
  input: SetBreakpointInput,
): Promise<BreakpointHandle> {
  const remoteRoot: RemoteRootSetting = input.remoteRoot ?? { kind: "none" };
  const urlRegex = buildBreakpointUrlRegex({ file: input.file, remoteRoot });
  const params: Record<string, unknown> = {
    lineNumber: input.line - 1,
    urlRegex,
  };
  if (input.condition !== undefined && input.condition.length > 0) {
    params["condition"] = input.condition;
  }
  const result = await session.client.send<CdpSetBreakpointResult>(
    "Debugger.setBreakpointByUrl",
    params,
  );
  const breakpointId = asString(result.breakpointId);
  if (breakpointId.length === 0) {
    throw new CfInspectorError(
      "CDP_REQUEST_FAILED",
      `setBreakpointByUrl did not return a breakpointId for ${input.file}:${input.line.toString()}`,
    );
  }
  return {
    breakpointId,
    file: input.file,
    line: input.line,
    urlRegex,
    resolvedLocations: toResolvedLocations(result.locations),
  };
}

export async function removeBreakpoint(
  session: InspectorSession,
  breakpointId: string,
): Promise<void> {
  await session.client.send("Debugger.removeBreakpoint", { breakpointId });
}

function toScopeChain(value: unknown): readonly ScopeInfo[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): ScopeInfo[] => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const candidate = entry as CdpScope;
    const type = asString(candidate.type);
    if (type.length === 0) {
      return [];
    }
    const objectId = typeof candidate.object?.objectId === "string" ? candidate.object.objectId : undefined;
    const name = typeof candidate.name === "string" ? candidate.name : undefined;
    const base: ScopeInfo = name === undefined
      ? { type }
      : { type, name };
    return [objectId === undefined ? base : { ...base, objectId }];
  });
}

function toCallFrames(value: unknown): readonly CallFrameInfo[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): CallFrameInfo[] => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const candidate = entry as CdpCallFrame;
    const callFrameId = asString(candidate.callFrameId);
    if (callFrameId.length === 0) {
      return [];
    }
    const url = typeof candidate.url === "string" ? candidate.url : undefined;
    const lineNumber = asNumber(candidate.location?.lineNumber);
    const columnNumber = asNumber(candidate.location?.columnNumber);
    const base: CallFrameInfo = {
      callFrameId,
      functionName: asString(candidate.functionName),
      lineNumber,
      columnNumber,
      scopeChain: toScopeChain(candidate.scopeChain),
    };
    return [url === undefined ? base : { ...base, url }];
  });
}

export interface WaitForPauseOptions {
  readonly timeoutMs: number;
  readonly breakpointIds?: readonly string[];
  readonly unmatchedPausePolicy?: "wait-for-resume" | "fail";
  readonly onUnmatchedPause?: (pause: PauseEvent) => void;
}

function pauseMatches(pause: PauseEvent, breakpointIds: readonly string[] | undefined): boolean {
  if (breakpointIds === undefined || breakpointIds.length === 0) {
    return true;
  }
  return pause.hitBreakpoints.some((id) => breakpointIds.includes(id));
}

function toPauseEvent(params: CdpPauseParams, receivedAtMs: number): PauseEvent {
  return {
    reason: asString(params.reason),
    hitBreakpoints: Array.isArray(params.hitBreakpoints)
      ? params.hitBreakpoints.filter((id): id is string => typeof id === "string")
      : [],
    callFrames: toCallFrames(params.callFrames),
    receivedAtMs,
  };
}

function remainingUntil(deadlineMs: number): number {
  return Math.max(0, deadlineMs - performance.now());
}

function topFrameLocation(pause: PauseEvent): string {
  const top = pause.callFrames[0];
  if (top === undefined) {
    return "(no call frame)";
  }
  const url = top.url !== undefined && top.url.length > 0 ? top.url : "(unknown)";
  return `${url}:${(top.lineNumber + 1).toString()}:${(top.columnNumber + 1).toString()}`;
}

function pauseDetail(pause: PauseEvent): string {
  return JSON.stringify({
    reason: pause.reason,
    hitBreakpoints: pause.hitBreakpoints,
    topFrame: topFrameLocation(pause),
  });
}

function hasResumedSincePause(session: InspectorSession, pause: PauseEvent): boolean {
  const pauseAt = pause.receivedAtMs;
  const resumedAt = session.debuggerState.lastResumedAtMs;
  return pauseAt !== undefined && resumedAt !== undefined && resumedAt >= pauseAt;
}

function throwBreakpointTimeout(timeoutMs: number): never {
  throw new CfInspectorError(
    "BREAKPOINT_NOT_HIT",
    `Timed out waiting for matching Debugger.paused after ${timeoutMs.toString()}ms`,
  );
}

function throwUnrelatedPauseTimeout(pause: PauseEvent, timeoutMs: number): never {
  throw new CfInspectorError(
    "UNRELATED_PAUSE_TIMEOUT",
    `Target stayed paused by another debugger event before this command's breakpoint could hit within ${timeoutMs.toString()}ms`,
    pauseDetail(pause),
  );
}

async function waitForUnmatchedPauseToResume(
  session: InspectorSession,
  pause: PauseEvent,
  deadlineMs: number,
  timeoutMs: number,
): Promise<void> {
  if (hasResumedSincePause(session, pause)) {
    return;
  }
  const remainingMs = remainingUntil(deadlineMs);
  if (remainingMs <= 0) {
    throwUnrelatedPauseTimeout(pause, timeoutMs);
  }
  try {
    await session.client.waitFor("Debugger.resumed", { timeoutMs: remainingMs });
    session.debuggerState.lastResumedAtMs = performance.now();
  } catch (err: unknown) {
    if (err instanceof CfInspectorError && err.code === "BREAKPOINT_NOT_HIT") {
      throwUnrelatedPauseTimeout(pause, timeoutMs);
    }
    throw err;
  }
}

async function handleUnmatchedPause(
  session: InspectorSession,
  pause: PauseEvent,
  options: WaitForPauseOptions,
  deadlineMs: number,
): Promise<void> {
  if (options.unmatchedPausePolicy === "fail") {
    throw new CfInspectorError(
      "UNRELATED_PAUSE",
      "Target paused before this command's breakpoint was reached",
      pauseDetail(pause),
    );
  }
  if (hasResumedSincePause(session, pause)) {
    return;
  }
  options.onUnmatchedPause?.(pause);
  await waitForUnmatchedPauseToResume(session, pause, deadlineMs, options.timeoutMs);
}

export async function waitForPause(
  session: InspectorSession,
  options: WaitForPauseOptions,
): Promise<PauseEvent> {
  const deadlineMs = performance.now() + options.timeoutMs;
  // Check the buffer first — a breakpoint may have fired between setBreakpoint
  // returning and waitForPause being called (the inspectee runs continuously).
  const buffer = session.pauseBuffer;
  while (buffer.length > 0 || remainingUntil(deadlineMs) > 0) {
    while (buffer.length > 0) {
      const buffered = buffer.shift();
      if (buffered === undefined) {
        continue;
      }
      if (pauseMatches(buffered, options.breakpointIds)) {
        return buffered;
      }
      await handleUnmatchedPause(session, buffered, options, deadlineMs);
    }

    const remainingMs = remainingUntil(deadlineMs);
    if (remainingMs <= 0) {
      throwBreakpointTimeout(options.timeoutMs);
    }
    session.pauseWaitGate.active = true;
    let receivedAtMs: number | undefined;
    let params: CdpPauseParams;
    try {
      params = await session.client.waitFor<CdpPauseParams>("Debugger.paused", {
        timeoutMs: remainingMs,
        predicate: (): boolean => {
          receivedAtMs = performance.now();
          return true;
        },
      });
    } finally {
      session.pauseWaitGate.active = false;
    }
    const pause = toPauseEvent(params, receivedAtMs ?? performance.now());
    if (pauseMatches(pause, options.breakpointIds)) {
      return pause;
    }
    await handleUnmatchedPause(session, pause, options, deadlineMs);
  }
  throwBreakpointTimeout(options.timeoutMs);
}

export async function resume(session: InspectorSession): Promise<void> {
  await session.client.send("Debugger.resume");
}

export async function evaluateOnFrame(
  session: InspectorSession,
  callFrameId: string,
  expression: string,
): Promise<CdpEvalResult> {
  return await session.client.send<CdpEvalResult>("Debugger.evaluateOnCallFrame", {
    callFrameId,
    expression,
    returnByValue: false,
    generatePreview: true,
    silent: true,
  });
}

export async function evaluateGlobal(
  session: InspectorSession,
  expression: string,
): Promise<CdpEvalResult> {
  return await session.client.send<CdpEvalResult>("Runtime.evaluate", {
    expression,
    returnByValue: false,
    generatePreview: true,
    silent: true,
  });
}

export function listScripts(session: InspectorSession): readonly ScriptInfo[] {
  return [...session.scripts.values()];
}

interface CdpCompileResult {
  scriptId?: unknown;
  exceptionDetails?: { text?: unknown; exception?: { description?: unknown } };
}

/**
 * Pre-compile a JS expression on the inspectee using Runtime.compileScript so
 * syntax errors surface as a CfInspectorError("INVALID_EXPRESSION") instead of
 * being silently swallowed by V8 when wired into a breakpoint condition or a
 * logpoint. Without this guard, a typo in --condition or --expr causes the
 * breakpoint to silently never fire — the user would see BREAKPOINT_NOT_HIT
 * after the timeout and have no idea why.
 *
 * persistScript: false — we don't actually want the compiled script around;
 * we just want V8 to parse it and report any SyntaxError.
 */
export async function validateExpression(
  session: InspectorSession,
  expression: string,
): Promise<void> {
  const result = await session.client.send<CdpCompileResult>("Runtime.compileScript", {
    expression,
    sourceURL: "<cf-inspector-validate>",
    persistScript: false,
  });
  if (result.exceptionDetails === undefined) {
    return;
  }
  const description =
    typeof result.exceptionDetails.exception?.description === "string"
      ? result.exceptionDetails.exception.description
      : (typeof result.exceptionDetails.text === "string"
          ? result.exceptionDetails.text
          : "expression failed to compile");
  throw new CfInspectorError("INVALID_EXPRESSION", description);
}

interface CdpProperty {
  name?: unknown;
  value?: { type?: unknown; value?: unknown; description?: unknown; objectId?: unknown };
}

export async function getProperties(
  session: InspectorSession,
  objectId: string,
): Promise<readonly CdpProperty[]> {
  const result = await session.client.send<{ result?: unknown }>("Runtime.getProperties", {
    objectId,
    ownProperties: true,
    accessorPropertiesOnly: false,
    generatePreview: true,
  });
  if (!Array.isArray(result.result)) {
    return [];
  }
  return result.result as readonly CdpProperty[];
}

export type { CdpEvalResult, CdpProperty };
