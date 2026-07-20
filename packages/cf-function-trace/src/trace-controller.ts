import { performance } from "node:perf_hooks";

import type { ScriptLocation } from "@saptools/cf-inspector";

import { TraceDataError } from "./errors.js";
import { isAppOwnedScript } from "./script-resolver.js";

export interface ControllerFrame {
  readonly callFrameId: string;
  readonly functionName: string;
  readonly scriptId: string;
  readonly url: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
}

export interface ControllerPause {
  readonly reason: string;
  readonly frames: readonly ControllerFrame[];
}

export interface TracePlan {
  readonly functionSelector: string;
  readonly scriptId: string;
  readonly scriptUrl: string;
  readonly sourceHash: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly entryLocation: ScriptLocation;
  readonly appRoots: readonly string[];
  readonly callDepth: number;
  readonly entryCondition?: string;
  readonly asynchronous?: boolean;
}

export interface PauseWaitInput {
  readonly timeoutMs: number;
  readonly breakpointId?: string;
  readonly signal?: AbortSignal;
}

export interface TraceControllerPort {
  setEntryBreakpoint(location: ScriptLocation, condition?: string): Promise<string>;
  waitForPause(input: PauseWaitInput): Promise<ControllerPause>;
  captureState(pause: ControllerPause): Promise<unknown>;
  stepInto(): Promise<void>;
  stepOver(): Promise<void>;
  stepOut(): Promise<void>;
  resume(): Promise<void>;
  removeBreakpoint(breakpointId: string): Promise<void>;
  enableExceptionPauses(): Promise<void>;
  disableExceptionPauses(): Promise<void>;
  setAsyncCallStackDepth?(maxDepth: number): Promise<void>;
  evaluateActivationCondition?(callFrameId: string, expression: string): Promise<boolean>;
}

export interface TraceStateRecord {
  readonly seq: number;
  readonly kind: "baseline" | "pause" | "exception";
  readonly functionName: string;
  readonly depth: number;
  readonly lineNumber: number;
  readonly columnNumber: number;
  readonly state: unknown;
}

export interface TraceProgressEvent {
  readonly kind: "breakpoint-armed";
}

export interface RecordTraceOptions {
  readonly timeoutMs: number;
  readonly maxSteps: number;
  readonly maxPausedMs: number;
  readonly asyncStackDepth?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly onState: (record: TraceStateRecord) => Promise<void>;
  readonly onProgress?: (event: TraceProgressEvent) => Promise<void>;
}

export interface RecordTraceResult {
  readonly stopReason: "function-returned" | "max-steps" | "exception";
  readonly stepCount: number;
}

type StepAction = "into" | "over" | "out";

interface ControllerState {
  breakpointId?: string;
  exceptionPausesEnabled: boolean;
  asyncStacksEnabled: boolean;
  ownsPause: boolean;
  pauseStartedAt?: number;
  pausedTotalMs: number;
  stepCount: number;
  recordSeq: number;
}

interface OperationBudget {
  readonly timeoutMs: number;
  readonly timeoutError: TraceDataError;
}

const MIN_CLEANUP_TIMEOUT_MS = 50;
const MAX_CLEANUP_TIMEOUT_MS = 1_000;
const MAX_FOREIGN_PAUSE_SKIPS = 100_000;

function validateLimits(plan: TracePlan, options: RecordTraceOptions): void {
  const validDepth = Number.isInteger(plan.callDepth) && plan.callDepth >= 0 && plan.callDepth <= 2;
  const budgets = [options.timeoutMs, options.maxSteps, options.maxPausedMs];
  const validBudgets = budgets.every((value) => Number.isSafeInteger(value) && value > 0);
  if (!validDepth || !validBudgets) {
    throw new TraceDataError("INVALID_ARGUMENT", "Trace depth and budgets are outside their supported ranges.");
  }
}

function isWithinFunction(plan: TracePlan, frame: ControllerFrame): boolean {
  if (frame.scriptId !== plan.scriptId || frame.lineNumber < plan.startLine || frame.lineNumber > plan.endLine) {
    return false;
  }
  if (frame.lineNumber === plan.startLine && frame.columnNumber < plan.startColumn) {
    return false;
  }
  return frame.lineNumber !== plan.endLine || frame.columnNumber < plan.endColumn;
}

function rootFrameIndex(plan: TracePlan, pause: ControllerPause): number {
  for (let index = pause.frames.length - 1; index >= 0; index -= 1) {
    const frame = pause.frames[index];
    if (frame !== undefined && isWithinFunction(plan, frame)) {
      return index;
    }
  }
  return -1;
}

function appDepth(plan: TracePlan, pause: ControllerPause, rootIndex: number): number {
  return pause.frames.slice(0, rootIndex)
    .filter((frame) => isAppOwnedScript(frame.url, plan.appRoots)).length;
}

function stepAction(plan: TracePlan, pause: ControllerPause, rootIndex: number): StepAction {
  const topFrame = pause.frames[0];
  if (topFrame === undefined || !isAppOwnedScript(topFrame.url, plan.appRoots)) {
    return "out";
  }
  return appDepth(plan, pause, rootIndex) < plan.callDepth ? "into" : "over";
}

function remainingMs(deadline: number, now: () => number): number {
  const remaining = deadline - now();
  if (remaining <= 0) {
    throw new TraceDataError("TRACE_TIMEOUT", "Timed out while waiting for the selected function.");
  }
  return remaining;
}

function overallBudget(deadline: number, now: () => number): OperationBudget {
  return {
    timeoutMs: Math.ceil(remainingMs(deadline, now)),
    timeoutError: new TraceDataError("TRACE_TIMEOUT", "The overall trace deadline was exceeded."),
  };
}

function pausedBudget(
  deadline: number,
  state: ControllerState,
  options: RecordTraceOptions,
): OperationBudget {
  const now = options.now ?? performance.now.bind(performance);
  const overallRemaining = remainingMs(deadline, now);
  const currentPause = state.pauseStartedAt === undefined ? 0 : now() - state.pauseStartedAt;
  const pauseRemaining = options.maxPausedMs - state.pausedTotalMs - currentPause;
  if (pauseRemaining <= 0) {
    throw new TraceDataError("MAX_PAUSED_TIME", "Maximum cumulative paused time was exceeded.");
  }
  const pauseLimitWins = pauseRemaining <= overallRemaining;
  return {
    timeoutMs: Math.max(1, Math.ceil(pauseLimitWins ? pauseRemaining : overallRemaining)),
    timeoutError: pauseLimitWins
      ? new TraceDataError("MAX_PAUSED_TIME", "Maximum cumulative paused time was exceeded.")
      : new TraceDataError("TRACE_TIMEOUT", "The overall trace deadline was exceeded."),
  };
}

async function runBoundedOperation<TResult>(
  operation: () => Promise<TResult>,
  budget: OperationBudget,
  signal?: AbortSignal,
): Promise<TResult> {
  if (signal?.aborted === true) {
    throw new TraceDataError("TRACE_ABORTED", "Tracing was aborted.");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(budget.timeoutError); }, budget.timeoutMs);
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal !== undefined) {
      onAbort = (): void => { reject(new TraceDataError("TRACE_ABORTED", "Tracing was aborted.")); };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([operation(), timeout, aborted]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

async function isForeignPause(
  plan: TracePlan,
  pause: ControllerPause,
  port: TraceControllerPort,
): Promise<boolean> {
  // Foreign pauses can only appear once the isolate is resumed across an await,
  // so synchronous traces never treat any pause as foreign.
  if (plan.asynchronous !== true) {
    return false;
  }
  // Our own step completions arrive as "step" on Node 22+ but "other" on Node 20;
  // only exception-style pauses can interleave from unrelated code during an await
  // gap, so anything that is not an exception is this activation's own step.
  if (pause.reason !== "exception" && pause.reason !== "promiseRejection") {
    return false;
  }
  const rootIndex = rootFrameIndex(plan, pause);
  if (rootIndex < 0) {
    return true;
  }
  const predicate = plan.entryCondition;
  const evaluate = port.evaluateActivationCondition?.bind(port);
  const frame = pause.frames[rootIndex];
  if (predicate !== undefined && evaluate !== undefined && frame !== undefined) {
    return !(await evaluate(frame.callFrameId, predicate));
  }
  return false;
}

async function waitForOwnedPause(
  plan: TracePlan,
  port: TraceControllerPort,
  state: ControllerState,
  options: RecordTraceOptions,
  deadline: number,
  breakpointId?: string,
): Promise<ControllerPause> {
  const now = options.now ?? performance.now.bind(performance);
  for (let skips = 0; skips <= MAX_FOREIGN_PAUSE_SKIPS; skips += 1) {
    const pause = await port.waitForPause({
      timeoutMs: remainingMs(deadline, now),
      ...(breakpointId === undefined ? {} : { breakpointId }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (breakpointId !== undefined || !(await isForeignPause(plan, pause, port))) {
      state.ownsPause = true;
      state.pauseStartedAt = now();
      return pause;
    }
    // Another activation paused the shared isolate during an await gap. Release it
    // and keep waiting for the traced activation's own continuation.
    await port.resume();
  }
  throw new TraceDataError("TRACE_ABORTED", "Too many unrelated pauses while waiting for the traced activation.");
}

function updatePausedBudget(state: ControllerState, options: RecordTraceOptions): void {
  const now = options.now ?? performance.now.bind(performance);
  const startedAt = state.pauseStartedAt;
  const current = startedAt === undefined ? 0 : now() - startedAt;
  if (state.pausedTotalMs + current > options.maxPausedMs) {
    throw new TraceDataError("MAX_PAUSED_TIME", "Maximum cumulative paused time was exceeded.");
  }
}

async function emitCapturedState(
  plan: TracePlan,
  pause: ControllerPause,
  rootIndex: number,
  state: ControllerState,
  options: RecordTraceOptions,
  port: TraceControllerPort,
  deadline: number,
  kind?: TraceStateRecord["kind"],
): Promise<void> {
  const frame = kind === "exception"
    ? pause.frames.find((candidate) => isAppOwnedScript(candidate.url, plan.appRoots))
    : pause.frames[0];
  if (frame === undefined) {
    return;
  }
  const captured = await runBoundedOperation(
    async (): Promise<unknown> => await port.captureState(pause),
    pausedBudget(deadline, state, options),
    options.signal,
  );
  const record: TraceStateRecord = {
    seq: state.recordSeq,
    kind: kind ?? (state.recordSeq === 0 ? "baseline" : "pause"),
    functionName: frame.functionName,
    depth: appDepth(plan, pause, rootIndex),
    lineNumber: frame.lineNumber,
    columnNumber: frame.columnNumber,
    state: captured,
  };
  await runBoundedOperation(
    async (): Promise<void> => { await options.onState(record); },
    pausedBudget(deadline, state, options),
    options.signal,
  );
  state.recordSeq += 1;
  updatePausedBudget(state, options);
}

async function issueStep(
  action: StepAction,
  port: TraceControllerPort,
  state: ControllerState,
  options: RecordTraceOptions,
  deadline: number,
): Promise<void> {
  updatePausedBudget(state, options);
  const step = action === "into"
    ? async (): Promise<void> => { await port.stepInto(); }
    : action === "out"
      ? async (): Promise<void> => { await port.stepOut(); }
      : async (): Promise<void> => { await port.stepOver(); };
  await runBoundedOperation(step, pausedBudget(deadline, state, options), options.signal);
  const now = options.now ?? performance.now.bind(performance);
  state.pausedTotalMs += state.pauseStartedAt === undefined ? 0 : now() - state.pauseStartedAt;
  delete state.pauseStartedAt;
  state.ownsPause = false;
  state.stepCount += 1;
}

async function runTraceLoop(
  plan: TracePlan,
  options: RecordTraceOptions,
  port: TraceControllerPort,
  state: ControllerState,
  deadline: number,
): Promise<RecordTraceResult> {
  let pause = await waitForOwnedPause(plan, port, state, options, deadline, state.breakpointId);
  await disarmEntryBreakpoint(port, state, options, deadline);
  await enableOwnedExceptionPauses(port, state, options, deadline);
  let rootIndex = rootFrameIndex(plan, pause);
  while (rootIndex >= 0) {
    if (pause.reason === "exception" || pause.reason === "promiseRejection") {
      await emitCapturedState(plan, pause, rootIndex, state, options, port, deadline, "exception");
      return { stopReason: "exception", stepCount: state.stepCount };
    }
    const action = stepAction(plan, pause, rootIndex);
    if (action !== "out") {
      await emitCapturedState(plan, pause, rootIndex, state, options, port, deadline);
    }
    if (state.stepCount >= options.maxSteps) {
      return { stopReason: "max-steps", stepCount: state.stepCount };
    }
    await issueStep(action, port, state, options, deadline);
    pause = await waitForOwnedPause(plan, port, state, options, deadline);
    rootIndex = rootFrameIndex(plan, pause);
  }
  return { stopReason: "function-returned", stepCount: state.stepCount };
}

async function disarmEntryBreakpoint(
  port: TraceControllerPort,
  state: ControllerState,
  options: RecordTraceOptions,
  deadline: number,
): Promise<void> {
  const breakpointId = state.breakpointId;
  if (breakpointId === undefined) {
    return;
  }
  await runBoundedOperation(
    async (): Promise<void> => { await port.removeBreakpoint(breakpointId); },
    pausedBudget(deadline, state, options),
    options.signal,
  );
  delete state.breakpointId;
}

async function enableOwnedExceptionPauses(
  port: TraceControllerPort,
  state: ControllerState,
  options: RecordTraceOptions,
  deadline: number,
): Promise<void> {
  state.exceptionPausesEnabled = true;
  await runBoundedOperation(
    async (): Promise<void> => { await port.enableExceptionPauses(); },
    pausedBudget(deadline, state, options),
    options.signal,
  );
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Unknown trace failure");
}

async function cleanupAction(
  operation: () => Promise<void>,
  timeoutMs: number,
): Promise<Error | undefined> {
  try {
    await runBoundedOperation(operation, {
      timeoutMs,
      timeoutError: new TraceDataError("CLEANUP_FAILED", "Inspector cleanup timed out."),
    });
    return undefined;
  } catch (error: unknown) {
    return asError(error);
  }
}

async function cleanupAsyncStacks(
  state: ControllerState,
  port: TraceControllerPort,
  timeoutMs: number,
): Promise<Error | undefined> {
  const resetAsyncDepth = port.setAsyncCallStackDepth?.bind(port);
  if (!state.asyncStacksEnabled || resetAsyncDepth === undefined) {
    return undefined;
  }
  return await cleanupAction(async (): Promise<void> => { await resetAsyncDepth(0); }, timeoutMs);
}

async function cleanupTrace(
  state: ControllerState,
  port: TraceControllerPort,
  options: RecordTraceOptions,
): Promise<{ readonly errors: readonly Error[]; readonly resumeError?: Error }> {
  const errors: Error[] = [];
  let resumeError: Error | undefined;
  const timeoutMs = Math.min(MAX_CLEANUP_TIMEOUT_MS, Math.max(MIN_CLEANUP_TIMEOUT_MS, options.maxPausedMs));
  if (state.exceptionPausesEnabled) {
    const exceptionError = await cleanupAction(
      async (): Promise<void> => { await port.disableExceptionPauses(); },
      timeoutMs,
    );
    if (exceptionError !== undefined) {
      errors.push(exceptionError);
    }
  }
  const asyncError = await cleanupAsyncStacks(state, port, timeoutMs);
  if (asyncError !== undefined) {
    errors.push(asyncError);
  }
  if (state.breakpointId !== undefined) {
    const breakpointId = state.breakpointId;
    const breakpointError = await cleanupAction(
      async (): Promise<void> => { await port.removeBreakpoint(breakpointId); },
      timeoutMs,
    );
    if (breakpointError !== undefined) {
      errors.push(breakpointError);
    }
  }
  if (state.ownsPause) {
    resumeError = await cleanupAction(async (): Promise<void> => { await port.resume(); }, timeoutMs);
    if (resumeError !== undefined) {
      errors.push(resumeError);
    }
  }
  return { errors, ...(resumeError === undefined ? {} : { resumeError }) };
}

function cleanupFailure(primary: Error | undefined, cleanup: {
  readonly errors: readonly Error[];
  readonly resumeError?: Error;
}): TraceDataError {
  const errors = primary === undefined ? [...cleanup.errors] : [primary, ...cleanup.errors];
  const message = cleanup.resumeError === undefined
    ? "Inspector cleanup did not complete after tracing."
    : "Inspector cleanup failed and target resume could not be confirmed.";
  const cause = errors.length === 1 ? errors[0] : new AggregateError(errors, message);
  return new TraceDataError("CLEANUP_FAILED", message, undefined, cause);
}

async function enableOwnedAsyncStacks(
  plan: TracePlan,
  options: RecordTraceOptions,
  port: TraceControllerPort,
  state: ControllerState,
  deadline: number,
  now: () => number,
): Promise<void> {
  const setDepth = port.setAsyncCallStackDepth?.bind(port);
  const depth = options.asyncStackDepth ?? 0;
  if (plan.asynchronous !== true || setDepth === undefined || depth <= 0) {
    return;
  }
  state.asyncStacksEnabled = true;
  await runBoundedOperation(
    async (): Promise<void> => { await setDepth(depth); },
    overallBudget(deadline, now),
    options.signal,
  );
}

async function prepareTrace(
  plan: TracePlan,
  options: RecordTraceOptions,
  port: TraceControllerPort,
  state: ControllerState,
  deadline: number,
  now: () => number,
): Promise<void> {
  state.breakpointId = await runBoundedOperation(
    async (): Promise<string> => await port.setEntryBreakpoint(plan.entryLocation, plan.entryCondition),
    overallBudget(deadline, now),
    options.signal,
  );
  await enableOwnedAsyncStacks(plan, options, port, state, deadline, now);
  if (options.onProgress !== undefined) {
    const onProgress = options.onProgress;
    await runBoundedOperation(
      async (): Promise<void> => { await onProgress({ kind: "breakpoint-armed" }); },
      overallBudget(deadline, now),
      options.signal,
    );
  }
}

export async function recordFunctionTrace(
  plan: TracePlan,
  options: RecordTraceOptions,
  port: TraceControllerPort,
): Promise<RecordTraceResult> {
  validateLimits(plan, options);
  const now = options.now ?? performance.now.bind(performance);
  const state: ControllerState = {
    ownsPause: false,
    exceptionPausesEnabled: false,
    asyncStacksEnabled: false,
    pausedTotalMs: 0,
    stepCount: 0,
    recordSeq: 0,
  };
  let result: RecordTraceResult | undefined;
  let failure: Error | undefined;
  const deadline = now() + options.timeoutMs;
  try {
    await prepareTrace(plan, options, port, state, deadline, now);
    result = await runTraceLoop(plan, options, port, state, deadline);
  } catch (error: unknown) {
    failure = asError(error);
  }
  const cleanup = await cleanupTrace(state, port, options);
  if (cleanup.errors.length > 0) {
    throw cleanupFailure(failure, cleanup);
  }
  if (failure !== undefined) {
    throw failure;
  }
  if (result === undefined) {
    throw new TraceDataError("CLEANUP_FAILED", "Trace ended without a result.");
  }
  return result;
}
