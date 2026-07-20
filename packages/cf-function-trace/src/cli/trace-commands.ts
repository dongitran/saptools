import process from "node:process";
import type { Writable } from "node:stream";

import type { InspectorSession } from "@saptools/cf-inspector";

import { withDefaultTraceSession } from "../default-session.js";
import { TraceDataError } from "../errors.js";
import {
  createInspectorTraceController,
  resolveRuntimeCwd,
  type InspectorTraceControllerOptions,
} from "../inspector-adapter.js";
import { planInspectorFunctionTrace, type PlanFunctionTraceInput } from "../planner.js";
import { createTraceRun, type TraceStoreOptions } from "../run-store.js";
import type { TraceTarget } from "../session.js";
import {
  recordFunctionTrace,
  type RecordTraceOptions,
  type RecordTraceResult,
  type TracePlan,
} from "../trace-controller.js";
import { createTraceRecorder, type TraceRecorder } from "../trace-recorder.js";

import { resolveRecordOptions, type RecordCliFlags, type ResolvedRecordOptions } from "./options.js";
import { writeJsonOutput } from "./output.js";

export interface TraceRuntime {
  resolveAppRoot(): Promise<string>;
  plan(input: PlanFunctionTraceInput): Promise<TracePlan>;
  record(
    plan: TracePlan,
    options: RecordTraceOptions,
    capture: InspectorTraceControllerOptions,
  ): Promise<RecordTraceResult>;
}

export interface TraceRuntimeRunner {
  withRuntime<TResult>(
    target: TraceTarget,
    callback: (runtime: TraceRuntime) => Promise<TResult>,
    signal?: AbortSignal,
  ): Promise<TResult>;
}

export interface TraceCommandContext {
  readonly stdout: Writable;
  readonly stderr?: Writable;
  readonly saptoolsRoot?: string;
  readonly signal?: AbortSignal;
  readonly runtimeRunner?: TraceRuntimeRunner;
}

interface RecordCommandResult extends RecordTraceResult {
  readonly runId: string;
  readonly directory: string;
  readonly status: "completed" | "partial";
}

function runtimeForSession(session: InspectorSession): TraceRuntime {
  return {
    resolveAppRoot: async (): Promise<string> => await resolveRuntimeCwd(session),
    plan: async (input): Promise<TracePlan> => await planInspectorFunctionTrace(session, input),
    record: async (plan, options, capture): Promise<RecordTraceResult> => (
      await recordFunctionTrace(plan, options, createInspectorTraceController(session, capture))
    ),
  };
}

const DEFAULT_RUNTIME_RUNNER: TraceRuntimeRunner = {
  withRuntime: async <TResult>(
    target: TraceTarget,
    callback: (runtime: TraceRuntime) => Promise<TResult>,
    signal?: AbortSignal,
  ): Promise<TResult> => (
    await withDefaultTraceSession(target, async (session): Promise<TResult> => (
      await callback(runtimeForSession(session))
    ), signal)
  ),
};

function commandContext(context: TraceCommandContext | undefined): TraceCommandContext {
  return context ?? { stdout: process.stdout };
}

function runner(context: TraceCommandContext): TraceRuntimeRunner {
  return context.runtimeRunner ?? DEFAULT_RUNTIME_RUNNER;
}

function storeOptions(context: TraceCommandContext): TraceStoreOptions {
  return context.saptoolsRoot === undefined ? {} : { saptoolsRoot: context.saptoolsRoot };
}

async function resolveAppRoots(runtime: TraceRuntime, explicitRoot: string | undefined): Promise<readonly string[]> {
  return [explicitRoot ?? await runtime.resolveAppRoot()];
}

function planInput(
  file: string,
  functionSelector: string,
  options: ResolvedRecordOptions,
  appRoots: readonly string[],
): PlanFunctionTraceInput {
  return { file, functionSelector, appRoots, callDepth: options.limits.callDepth };
}

function captureOptions(options: ResolvedRecordOptions, appRoots: readonly string[]): InspectorTraceControllerOptions {
  return {
    appRoots,
    maxFrames: options.limits.callDepth + 1,
    graphLimits: {
      maxDepth: options.limits.maxObjectDepth,
      maxProperties: options.limits.maxProperties,
      maxNodes: options.limits.maxNodes,
      maxBytes: options.limits.maxStateBytes,
    },
  };
}

function recordOptions(
  options: ResolvedRecordOptions,
  recorder: TraceRecorder,
  context: TraceCommandContext,
): RecordTraceOptions {
  const progressStream = context.stderr;
  return {
    timeoutMs: options.limits.timeoutMs,
    maxSteps: options.limits.maxSteps,
    maxPausedMs: options.limits.maxPausedMs,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(progressStream === undefined ? {} : {
      onProgress: async (): Promise<void> => {
        const written = await writeJsonOutput(progressStream, { event: "breakpoint-armed" }, 1024);
        if (!written) {
          throw new TraceDataError("TRACE_ABORTED", "Breakpoint consumer closed before tracing began.");
        }
      },
    }),
    onState: async (record): Promise<void> => {
      await recorder.record(record);
    },
  };
}

function failedStatus(error: unknown, signal: AbortSignal | undefined): "failed" | "partial" | "cancelled" {
  const code: unknown = error instanceof Error && "code" in error ? error.code : undefined;
  if (signal?.aborted === true || code === "TRACE_ABORTED") {
    return "cancelled";
  }
  return code === "TRACE_TIMEOUT" || code === "MAX_PAUSED_TIME" || code === "MAX_STEPS"
    ? "partial"
    : "failed";
}

async function executeRecord(
  runtime: TraceRuntime,
  file: string,
  functionSelector: string,
  options: ResolvedRecordOptions,
  context: TraceCommandContext,
): Promise<RecordCommandResult> {
  const appRoots = await resolveAppRoots(runtime, options.appRoot);
  const plan = await runtime.plan(planInput(file, functionSelector, options, appRoots));
  const run = await createTraceRun({
    sourceUrl: plan.scriptUrl,
    sourceHash: plan.sourceHash,
    functionSelector: plan.functionSelector,
  }, storeOptions(context));
  const recorder = createTraceRecorder(run, { checkpointEvery: options.limits.checkpointEvery });
  try {
    const result = await runtime.record(plan, recordOptions(options, recorder, context), captureOptions(options, appRoots));
    const status = result.stopReason === "max-steps" ? "partial" : "completed";
    const terminalKind = result.stopReason === "exception"
      ? "none"
      : result.stopReason === "function-returned" ? "completed" : "truncated";
    await recorder.complete(status, terminalKind);
    return { ...result, runId: run.runId, directory: run.directory, status };
  } catch (error: unknown) {
    await recorder.fail(failedStatus(error, context.signal));
    throw error;
  }
}

export async function runPlanCommand(
  file: string,
  functionSelector: string,
  flags: RecordCliFlags,
  suppliedContext?: TraceCommandContext,
): Promise<void> {
  const context = commandContext(suppliedContext);
  const options = resolveRecordOptions(flags);
  const plan = await runner(context).withRuntime(options.target, async (runtime): Promise<TracePlan> => {
    const appRoots = await resolveAppRoots(runtime, options.appRoot);
    return await runtime.plan(planInput(file, functionSelector, options, appRoots));
  }, context.signal);
  await writeJsonOutput(context.stdout, {
    functionSelector: plan.functionSelector,
    scriptUrl: plan.scriptUrl,
    sourceHash: plan.sourceHash,
    startLine: plan.startLine + 1,
    endLine: plan.endLine + 1,
    entryLine: plan.entryLocation.lineNumber + 1,
    entryColumn: (plan.entryLocation.columnNumber ?? 0) + 1,
    callDepth: plan.callDepth,
    appRoots: plan.appRoots,
  }, 24_000);
}

export async function runRecordCommand(
  file: string,
  functionSelector: string,
  flags: RecordCliFlags,
  suppliedContext?: TraceCommandContext,
): Promise<void> {
  const context = commandContext(suppliedContext);
  const options = resolveRecordOptions(flags);
  const result = await runner(context).withRuntime(options.target, async (runtime): Promise<RecordCommandResult> => (
    await executeRecord(runtime, file, functionSelector, options, context)
  ), context.signal);
  await writeJsonOutput(context.stdout, result, 4096);
}
