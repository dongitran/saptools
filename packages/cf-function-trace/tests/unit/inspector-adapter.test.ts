import { CfInspectorError } from "@saptools/cf-inspector";
import type {
  ExactBreakpointHandle,
  PauseEvent,
  ScriptLocation,
  WaitForPauseOptions,
} from "@saptools/cf-inspector";
import { describe, expect, it, vi } from "vitest";

import {
  createInspectorTraceControllerWithDependencies,
  resolveRuntimeCwd,
  type InspectorAdapterDependencies,
  type RuntimeEvaluationSession,
} from "../../src/inspector-adapter.js";
import type { GraphCaptureLimits } from "../../src/remote-object.js";
import {
  recordFunctionTrace,
  type TraceControllerPort,
  type TracePlan,
} from "../../src/trace-controller.js";

interface TestClient {
  send(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
}

interface TestSession extends RuntimeEvaluationSession {
  readonly marker: string;
  readonly client: TestClient;
}

function mockInspectorSession(client: TestClient): TestSession {
  return {
    marker: "inspector-session",
    client,
  };
}

const SESSION = mockInspectorSession({ send: async (): Promise<unknown> => ({}) });
const GRAPH_LIMITS: GraphCaptureLimits = {
  maxDepth: 3,
  maxProperties: 20,
  maxNodes: 30,
  maxBytes: 10_000,
};
const TRACE_PLAN: TracePlan = {
  functionSelector: "create",
  scriptId: "script-root",
  scriptUrl: "file:///home/vcap/app/dist/order.js",
  sourceHash: "a".repeat(64),
  startLine: 10,
  startColumn: 4,
  endLine: 20,
  endColumn: 1,
  entryLocation: { scriptId: "script-root", lineNumber: 10, columnNumber: 4 },
  appRoots: ["/home/vcap/app"],
  callDepth: 0,
};
const RICH_PAUSE: PauseEvent = {
  reason: "other",
  hitBreakpoints: ["bp-entry"],
  callFrames: [{
    callFrameId: "frame-root",
    functionName: "create",
    scriptId: "script-root",
    url: TRACE_PLAN.scriptUrl,
    lineNumber: 10,
    columnNumber: 4,
    scopeChain: [
      { type: "local", objectId: "scope-local" },
      { type: "closure", objectId: "scope-closure" },
    ],
    thisObject: { type: "object", className: "OrderService", objectId: "this-1" },
    returnValue: { type: "number", value: 7 },
  }],
};

function exactBreakpoint(location: ScriptLocation): ExactBreakpointHandle {
  return { breakpointId: "bp-entry", requestedLocation: location, actualLocation: location };
}

function createDependencies(
  overrides: Partial<InspectorAdapterDependencies<TestSession>> = {},
): InspectorAdapterDependencies<TestSession> {
  return {
    setBreakpointAtLocation: async (_session, input): Promise<ExactBreakpointHandle> => (
      exactBreakpoint(input.location)
    ),
    waitForPause: async (): Promise<PauseEvent> => RICH_PAUSE,
    getProperties: async (): Promise<readonly unknown[]> => [],
    releaseObject: async (): Promise<void> => undefined,
    stepInto: async (): Promise<void> => undefined,
    stepOver: async (): Promise<void> => undefined,
    stepOut: async (): Promise<void> => undefined,
    resume: async (): Promise<void> => undefined,
    removeBreakpoint: async (): Promise<void> => undefined,
    setPauseOnExceptions: async (): Promise<void> => undefined,
    ...overrides,
  };
}

function createController(
  dependencies = createDependencies(),
): TraceControllerPort {
  return createInspectorTraceControllerWithDependencies(SESSION, {
    appRoots: TRACE_PLAN.appRoots,
    maxFrames: 2,
    graphLimits: GRAPH_LIMITS,
  }, dependencies);
}

async function resolvesRuntimeCwd(): Promise<void> {
  const send = vi.fn(async (): Promise<unknown> => ({
    result: { type: "string", value: "/home/vcap/app" },
  }));
  const session = mockInspectorSession({ send });

  await expect(resolveRuntimeCwd(session)).resolves.toBe("/home/vcap/app");
  expect(send).toHaveBeenCalledWith("Runtime.evaluate", {
    expression: "process.cwd()",
    returnByValue: true,
    generatePreview: false,
    silent: true,
  });
}

async function rejectsInvalidRuntimeCwd(): Promise<void> {
  const exception = { exceptionDetails: { text: "evaluation failed" } };
  const malformed = { result: { type: "number", value: 42 } };
  const blank = { result: { type: "string", value: " " } };
  for (const response of [exception, malformed, blank]) {
    const send = async (): Promise<unknown> => response;
    await expect(resolveRuntimeCwd(mockInspectorSession({ send }))).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
}

interface RichScenario {
  readonly controller: TraceControllerPort;
  readonly calls: string[];
  readonly waits: WaitForPauseOptions[];
}

function createRichScenario(): RichScenario {
  const calls: string[] = [];
  const waits: WaitForPauseOptions[] = [];
  const dependencies = createDependencies({
    setBreakpointAtLocation: async (_session, input): Promise<ExactBreakpointHandle> => {
      calls.push(`set:${input.location.scriptId}:${input.location.lineNumber.toString()}`);
      return exactBreakpoint(input.location);
    },
    waitForPause: async (_session, options): Promise<PauseEvent> => {
      waits.push(options);
      return RICH_PAUSE;
    },
    getProperties: async (_session, objectId): Promise<readonly unknown[]> => {
      calls.push(`get:${objectId}`);
      if (objectId === "scope-local") {
        return [
          { name: "input", value: { type: "string", value: "order-42" } },
          { name: "computed", get: { type: "function", objectId: "getter-1" } },
          { value: { type: "string", value: "missing-name" } },
        ];
      }
      return objectId === "this-1"
        ? [{ name: "service", value: { type: "string", value: "orders" } }]
        : [];
    },
    releaseObject: async (_session, objectId): Promise<void> => { calls.push(`release:${objectId}`); },
    stepInto: async (): Promise<void> => { calls.push("step:into"); },
    stepOver: async (): Promise<void> => { calls.push("step:over"); },
    stepOut: async (): Promise<void> => { calls.push("step:out"); },
    resume: async (): Promise<void> => { calls.push("resume"); },
    removeBreakpoint: async (): Promise<void> => { calls.push("breakpoint:remove"); },
  });
  return { controller: createController(dependencies), calls, waits };
}

async function mapsRichInspectorState(): Promise<void> {
  const { controller, calls, waits } = createRichScenario();
  const signal = new AbortController().signal;
  await expect(controller.setEntryBreakpoint(TRACE_PLAN.entryLocation)).resolves.toBe("bp-entry");
  const pause = await controller.waitForPause({ timeoutMs: 5_000, breakpointId: "bp-entry", signal });
  const captured = await controller.captureState(pause);
  await controller.stepInto();
  await controller.stepOver();
  await controller.stepOut();
  await controller.resume();
  await controller.removeBreakpoint("bp-entry");

  expect(waits).toEqual([{ timeoutMs: 5_000, breakpointIds: ["bp-entry"], signal }]);
  expect(captured).toMatchObject({
    version: 1,
    frames: [{
      functionName: "create",
      roots: { "scope.0.local.input": "order-42", return: 7, this: { kind: "ref", nodeId: "n0" } },
    }],
  });
  expect(calls).toContain("get:scope-local");
  expect(calls).not.toContain("get:scope-closure");
  expect(calls).toContain("release:scope-local");
  expect(calls).toContain("release:this-1");
  expect(calls).not.toContain("release:getter-1");
  expect(calls.slice(-5)).toEqual(["step:into", "step:over", "step:out", "resume", "breakpoint:remove"]);
}

async function mapsAbortedWait(): Promise<void> {
  const signal = new AbortController().signal;
  const waitForPause = vi.fn(async (): Promise<never> => {
    throw new CfInspectorError("ABORTED", "wait aborted");
  });
  const controller = createController(createDependencies({ waitForPause }));

  await expect(controller.waitForPause({ timeoutMs: 100, signal })).rejects.toMatchObject({
    code: "TRACE_ABORTED",
  });
  expect(waitForPause).toHaveBeenCalledWith(SESSION, { timeoutMs: 100, signal });
}

async function mapsBreakpointTimeout(): Promise<void> {
  const waitForPause = async (): Promise<never> => {
    throw new CfInspectorError("BREAKPOINT_NOT_HIT", "wait timed out");
  };
  await expect(createController(createDependencies({ waitForPause })).waitForPause({
    timeoutMs: 100,
  })).rejects.toMatchObject({ code: "BREAKPOINT_NOT_HIT" });
}

async function rejectsForeignPauseCapture(): Promise<void> {
  await expect(createController().captureState({ reason: "other", frames: [] })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
}

async function preservesOwnedCleanupOrder(): Promise<void> {
  const calls: string[] = [];
  const controller = createController(createDependencies({
    setBreakpointAtLocation: async (_session, input): Promise<ExactBreakpointHandle> => {
      calls.push("breakpoint:set");
      return exactBreakpoint(input.location);
    },
    waitForPause: async (): Promise<PauseEvent> => RICH_PAUSE,
    getProperties: async (): Promise<never> => { throw new Error("capture failed"); },
    releaseObject: async (_session, objectId): Promise<void> => { calls.push(`release:${objectId}`); },
    resume: async (): Promise<void> => { calls.push("resume"); },
    removeBreakpoint: async (): Promise<void> => { calls.push("breakpoint:remove"); },
  }));

  await expect(recordFunctionTrace(TRACE_PLAN, {
    timeoutMs: 1_000,
    maxSteps: 10,
    maxPausedMs: 1_000,
    onState: async (): Promise<void> => undefined,
  }, controller)).rejects.toThrow("capture failed");
  expect(calls.indexOf("breakpoint:remove")).toBeLessThan(calls.indexOf("resume"));
  expect(calls.at(-1)).toBe("resume");
}

describe("cf-inspector trace controller adapter", () => {
  it("resolves cwd with only the fixed return-by-value expression", resolvesRuntimeCwd);
  it("fails closed on an exception or non-string cwd", rejectsInvalidRuntimeCwd);
  it("maps exact breakpoints, rich state, stepping, and releases", mapsRichInspectorState);
  it("forwards AbortSignal and maps inspector cancellation", mapsAbortedWait);
  it("maps inspector breakpoint timeouts", mapsBreakpointTimeout);
  it("rejects pause data not owned by this adapter", rejectsForeignPauseCapture);
  it("removes owned pause controls before the final resume", preservesOwnedCleanupOrder);
});
