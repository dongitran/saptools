import {
  CfInspectorError,
  evaluateOnFrame,
  getProperties,
  releaseObject,
  removeBreakpoint,
  resume,
  setAsyncCallStackDepth,
  setPauseOnExceptions,
  setBreakpointAtLocation,
  stepInto,
  stepOut,
  stepOver,
  waitForPause,
  type ExactBreakpointHandle,
  type InspectorSession,
  type PauseEvent,
  type ScriptLocation,
  type SetBreakpointAtLocationInput,
  type WaitForPauseOptions,
} from "@saptools/cf-inspector";

import { TraceDataError } from "./errors.js";
import type {
  GraphCaptureLimits,
  RemoteObject,
  RemoteObjectClient,
  RemotePropertyDescriptor,
} from "./remote-object.js";
import {
  capturePausedState,
  type PausedFrame,
  type PausedScope,
} from "./state-capture.js";
import type {
  ControllerPause,
  TraceControllerPort,
} from "./trace-controller.js";

export interface InspectorTraceControllerOptions {
  readonly appRoots: readonly string[];
  readonly maxFrames: number;
  readonly graphLimits: GraphCaptureLimits;
}

export interface RuntimeEvaluationClient {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface RuntimeEvaluationSession {
  readonly client: RuntimeEvaluationClient;
}

export interface AdapterEvalResult {
  readonly result?: { readonly value?: unknown; readonly type?: unknown };
  readonly exceptionDetails?: unknown;
}

export interface InspectorAdapterDependencies<TSession = InspectorSession> {
  setBreakpointAtLocation(
    session: TSession,
    input: SetBreakpointAtLocationInput,
  ): Promise<ExactBreakpointHandle>;
  waitForPause(session: TSession, options: WaitForPauseOptions): Promise<PauseEvent>;
  getProperties(session: TSession, objectId: string): Promise<readonly unknown[]>;
  releaseObject(session: TSession, objectId: string): Promise<void>;
  stepInto(session: TSession): Promise<void>;
  stepOver(session: TSession): Promise<void>;
  stepOut(session: TSession): Promise<void>;
  resume(session: TSession): Promise<void>;
  removeBreakpoint(session: TSession, breakpointId: string): Promise<void>;
  setPauseOnExceptions(session: TSession, state: "all" | "none" | "uncaught"): Promise<void>;
  setAsyncCallStackDepth(session: TSession, maxDepth: number): Promise<void>;
  evaluateOnFrame(session: TSession, callFrameId: string, expression: string): Promise<AdapterEvalResult>;
}

const DEFAULT_DEPENDENCIES: InspectorAdapterDependencies = {
  setBreakpointAtLocation,
  waitForPause,
  getProperties,
  releaseObject,
  stepInto,
  stepOver,
  stepOut,
  resume,
  removeBreakpoint,
  setPauseOnExceptions,
  setAsyncCallStackDepth,
  evaluateOnFrame,
};

export async function resolveRuntimeCwd(session: RuntimeEvaluationSession): Promise<string> {
  const evaluation = await session.client.send("Runtime.evaluate", {
    expression: "process.cwd()",
    returnByValue: true,
    generatePreview: false,
    silent: true,
  });
  const result = isRecord(evaluation) ? evaluation["result"] : undefined;
  const cwd = isRecord(result) ? result["value"] : undefined;
  if (
    !isRecord(evaluation)
    || evaluation["exceptionDetails"] !== undefined
    || !isRecord(result)
    || result["type"] !== "string"
    || typeof cwd !== "string"
    || cwd.trim().length === 0
  ) {
    throw new TraceDataError("INVALID_ARGUMENT", "The runtime working directory is unavailable.");
  }
  return cwd;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function remoteCompleteness(value: unknown): RemoteObject["completeness"] {
  return value === "truncated" || value === "unavailable" ? value : undefined;
}

function toRemoteObject(value: unknown): RemoteObject | undefined {
  if (!isRecord(value) || typeof value["type"] !== "string") {
    return undefined;
  }
  const subtype = optionalText(value["subtype"]);
  const className = optionalText(value["className"]);
  const completeness = remoteCompleteness(value["completeness"]);
  const unserializableValue = optionalText(value["unserializableValue"]);
  const description = optionalText(value["description"]);
  const objectId = optionalText(value["objectId"]);
  return {
    type: value["type"],
    ...(subtype === undefined ? {} : { subtype }),
    ...(className === undefined ? {} : { className }),
    ...(completeness === undefined ? {} : { completeness }),
    ...(Object.hasOwn(value, "value") ? { value: value["value"] } : {}),
    ...(unserializableValue === undefined ? {} : { unserializableValue }),
    ...(description === undefined ? {} : { description }),
    ...(objectId === undefined ? {} : { objectId }),
  };
}

function toPropertyDescriptor(value: unknown): RemotePropertyDescriptor | undefined {
  if (!isRecord(value) || typeof value["name"] !== "string") {
    return undefined;
  }
  const propertyValue = toRemoteObject(value["value"]);
  const getter = toRemoteObject(value["get"]);
  const setter = toRemoteObject(value["set"]);
  return {
    name: value["name"],
    ...(propertyValue === undefined ? {} : { value: propertyValue }),
    ...(getter === undefined ? {} : { get: getter }),
    ...(setter === undefined ? {} : { set: setter }),
  };
}

function toPropertyDescriptors(values: readonly unknown[]): readonly RemotePropertyDescriptor[] {
  return values.flatMap((value): RemotePropertyDescriptor[] => {
    const descriptor = toPropertyDescriptor(value);
    return descriptor === undefined ? [] : [descriptor];
  });
}

function toPausedScope(scope: PauseEvent["callFrames"][number]["scopeChain"][number]): PausedScope {
  const objectId = scope.objectId ?? scope.object?.objectId;
  return {
    type: scope.type,
    ...(objectId === undefined ? {} : { objectId }),
  };
}

function toPausedFrame(frame: PauseEvent["callFrames"][number]): PausedFrame {
  const thisValue = toRemoteObject(frame.thisObject);
  const returnValue = toRemoteObject(frame.returnValue);
  return {
    functionName: frame.functionName,
    scriptId: frame.scriptId ?? frame.functionLocation?.scriptId ?? "",
    url: frame.url ?? "",
    lineNumber: frame.lineNumber,
    columnNumber: frame.columnNumber,
    scopeChain: frame.scopeChain.map(toPausedScope),
    ...(thisValue === undefined ? {} : { thisValue }),
    ...(returnValue === undefined ? {} : { returnValue }),
  };
}

function controllerPause(pause: PauseEvent, frames: readonly PausedFrame[]): ControllerPause {
  return {
    reason: pause.reason,
    frames: frames.map((frame, index) => ({
      callFrameId: pause.callFrames[index]?.callFrameId ?? "",
      functionName: frame.functionName,
      scriptId: frame.scriptId,
      url: frame.url,
      lineNumber: frame.lineNumber,
      columnNumber: frame.columnNumber,
    })),
  };
}

function mapWaitError(error: unknown): Error {
  if (error instanceof CfInspectorError && error.code === "ABORTED") {
    return new TraceDataError("TRACE_ABORTED", "Tracing was aborted while waiting for a pause.");
  }
  if (error instanceof CfInspectorError && error.code === "BREAKPOINT_NOT_HIT") {
    return new TraceDataError("BREAKPOINT_NOT_HIT", "The selected function breakpoint was not hit.");
  }
  return error instanceof Error ? error : new Error("Unknown inspector wait failure");
}

function pauseWaitOptions(input: {
  readonly timeoutMs: number;
  readonly breakpointId?: string;
  readonly signal?: AbortSignal;
}): WaitForPauseOptions {
  return {
    timeoutMs: input.timeoutMs,
    ...(input.breakpointId === undefined ? {} : { breakpointIds: [input.breakpointId] }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

function remoteClient<TSession>(
  session: TSession,
  dependencies: InspectorAdapterDependencies<TSession>,
): RemoteObjectClient {
  return {
    getProperties: async (objectId): Promise<readonly RemotePropertyDescriptor[]> => (
      toPropertyDescriptors(await dependencies.getProperties(session, objectId))
    ),
    releaseObject: async (objectId): Promise<void> => {
      await dependencies.releaseObject(session, objectId);
    },
  };
}

async function captureAdapterState(
  pause: ControllerPause,
  frameLookup: WeakMap<ControllerPause, readonly PausedFrame[]>,
  options: InspectorTraceControllerOptions,
  objectClient: RemoteObjectClient,
): Promise<unknown> {
  const frames = frameLookup.get(pause);
  if (frames === undefined) {
    throw new TraceDataError("INVALID_ARGUMENT", "Pause state was not produced by this inspector adapter.");
  }
  return await capturePausedState({
    frames,
    appRoots: options.appRoots,
    maxFrames: options.maxFrames,
    graphLimits: options.graphLimits,
  }, objectClient);
}

type SteppingMethods = Pick<
  TraceControllerPort,
  | "stepInto"
  | "stepOver"
  | "stepOut"
  | "resume"
  | "removeBreakpoint"
  | "enableExceptionPauses"
  | "disableExceptionPauses"
  | "setAsyncCallStackDepth"
>;

function steppingMethods<TSession>(
  session: TSession,
  dependencies: InspectorAdapterDependencies<TSession>,
): SteppingMethods {
  return {
    stepInto: async (): Promise<void> => { await dependencies.stepInto(session); },
    stepOver: async (): Promise<void> => { await dependencies.stepOver(session); },
    stepOut: async (): Promise<void> => { await dependencies.stepOut(session); },
    resume: async (): Promise<void> => { await dependencies.resume(session); },
    removeBreakpoint: async (breakpointId): Promise<void> => {
      await dependencies.removeBreakpoint(session, breakpointId);
    },
    enableExceptionPauses: async (): Promise<void> => {
      await dependencies.setPauseOnExceptions(session, "uncaught");
    },
    disableExceptionPauses: async (): Promise<void> => {
      await dependencies.setPauseOnExceptions(session, "none");
    },
    setAsyncCallStackDepth: async (maxDepth): Promise<void> => {
      await dependencies.setAsyncCallStackDepth(session, maxDepth);
    },
  };
}

export function createInspectorTraceController(
  session: InspectorSession,
  options: InspectorTraceControllerOptions,
): TraceControllerPort {
  return createInspectorTraceControllerWithDependencies(session, options, DEFAULT_DEPENDENCIES);
}

export function createInspectorTraceControllerWithDependencies<TSession>(
  session: TSession,
  options: InspectorTraceControllerOptions,
  dependencies: InspectorAdapterDependencies<TSession>,
): TraceControllerPort {
  const frameLookup = new WeakMap<ControllerPause, readonly PausedFrame[]>();
  const objectClient = remoteClient(session, dependencies);
  return {
    setEntryBreakpoint: async (location: ScriptLocation, condition?: string): Promise<string> => (
      await dependencies.setBreakpointAtLocation(session, {
        location,
        ...(condition === undefined ? {} : { condition }),
      })
    ).breakpointId,
    waitForPause: async (input): Promise<ControllerPause> => {
      try {
        const pause = await dependencies.waitForPause(session, pauseWaitOptions(input));
        const frames = pause.callFrames.map(toPausedFrame);
        const mapped = controllerPause(pause, frames);
        frameLookup.set(mapped, frames);
        return mapped;
      } catch (error: unknown) {
        throw mapWaitError(error);
      }
    },
    captureState: async (pause): Promise<unknown> => (
      await captureAdapterState(pause, frameLookup, options, objectClient)
    ),
    ...steppingMethods(session, dependencies),
    evaluateActivationCondition: async (callFrameId, expression): Promise<boolean> => {
      const outcome = await dependencies.evaluateOnFrame(session, callFrameId, expression);
      if (outcome.exceptionDetails !== undefined) {
        // A predicate that throws in this frame cannot confirm the activation.
        return false;
      }
      return outcome.result?.value === true;
    },
  };
}
