import { describe, expect, it, vi } from "vitest";

import {
  recordFunctionTrace,
  type ControllerFrame,
  type ControllerPause,
  type TraceControllerPort,
  type TracePlan,
} from "../../src/trace-controller.js";

function rootFrame(lineNumber: number, functionName = "run"): ControllerFrame {
  return {
    callFrameId: `root-${lineNumber.toString()}`,
    functionName,
    scriptId: "script-root",
    url: "file:///home/vcap/app/dist/service.js",
    lineNumber,
    columnNumber: 0,
  };
}

function rootPause(lineNumber: number, functionName = "run"): ControllerPause {
  return { reason: "step", frames: [rootFrame(lineNumber, functionName)] };
}

function tracePlan(callDepth: number): TracePlan {
  return {
    functionSelector: "run",
    scriptId: "script-root",
    scriptUrl: "file:///home/vcap/app/dist/service.js",
    sourceHash: "a".repeat(64),
    startLine: 10,
    startColumn: 0,
    endLine: 20,
    endColumn: 100,
    entryLocation: { scriptId: "script-root", lineNumber: 10, columnNumber: 0 },
    appRoots: ["/home/vcap/app"],
    callDepth,
  };
}

function createPort(
  pauses: readonly ControllerPause[],
  captureState?: TraceControllerPort["captureState"],
  evaluate?: (callFrameId: string, expression: string) => Promise<boolean>,
): {
  readonly port: TraceControllerPort;
  readonly calls: string[];
} {
  const queue = [...pauses];
  const calls: string[] = [];
  const port: TraceControllerPort = {
    setEntryBreakpoint: async (_location, condition): Promise<string> => {
      calls.push(condition === undefined ? "breakpoint:set" : `breakpoint:set:${condition}`);
      return "bp-entry";
    },
    waitForPause: async (): Promise<ControllerPause> => {
      calls.push("pause:wait");
      const pause = queue.shift();
      if (pause === undefined) {
        throw new Error("pause queue exhausted");
      }
      return pause;
    },
    captureState: captureState ?? (async (pause): Promise<unknown> => {
        calls.push(`capture:${pause.frames[0]?.functionName ?? "none"}`);
        return { frame: pause.frames[0]?.functionName ?? "none", remaining: queue.length };
      }),
    stepInto: async (): Promise<void> => {
      calls.push("step:into");
    },
    stepOver: async (): Promise<void> => {
      calls.push("step:over");
    },
    stepOut: async (): Promise<void> => {
      calls.push("step:out");
    },
    resume: async (): Promise<void> => {
      calls.push("resume");
    },
    removeBreakpoint: async (): Promise<void> => {
      calls.push("breakpoint:remove");
    },
    enableExceptionPauses: async (): Promise<void> => {
      calls.push("exceptions:enable");
    },
    disableExceptionPauses: async (): Promise<void> => {
      calls.push("exceptions:disable");
    },
    setAsyncCallStackDepth: async (maxDepth): Promise<void> => {
      calls.push(`async-depth:${maxDepth.toString()}`);
    },
    evaluateActivationCondition: async (callFrameId, expression): Promise<boolean> => {
      calls.push(`eval:${expression}`);
      return evaluate === undefined ? true : await evaluate(callFrameId, expression);
    },
  };
  return { port, calls };
}

describe("function trace controller", () => {
  it("owns the entry pause before enabling exception pauses", async () => {
    const { calls, port } = createPort([
      rootPause(10),
      { reason: "step", frames: [] },
    ]);

    await recordFunctionTrace(tracePlan(0), {
      timeoutMs: 1_000,
      maxSteps: 10,
      maxPausedMs: 1_000,
      onState: async (): Promise<void> => undefined,
    }, port);

    expect(calls.indexOf("pause:wait")).toBeLessThan(calls.indexOf("breakpoint:remove"));
    expect(calls.indexOf("breakpoint:remove")).toBeLessThan(calls.indexOf("exceptions:enable"));
  });

  it("records depth-zero pauses and disarms owned controls before the final resume", async () => {
    const { calls, port } = createPort([
      rootPause(10),
      rootPause(12),
      { reason: "step", frames: [{
        callFrameId: "caller",
        functionName: "dispatch",
        scriptId: "script-root",
        url: "file:///home/vcap/app/dist/service.js",
        lineNumber: 30,
        columnNumber: 0,
      }] },
    ]);
    const records: unknown[] = [];
    const progress: unknown[] = [];

    const result = await recordFunctionTrace(tracePlan(0), {
      timeoutMs: 1_000,
      maxSteps: 10,
      maxPausedMs: 1_000,
      onState: async (record): Promise<void> => {
        records.push(record);
      },
      onProgress: async (event): Promise<void> => {
        progress.push(event);
      },
    }, port);

    expect(result).toEqual({ stopReason: "function-returned", stepCount: 2 });
    expect(records).toHaveLength(2);
    expect(progress).toEqual([{ kind: "breakpoint-armed" }]);
    expect(calls.filter((call) => call === "step:over")).toHaveLength(2);
    expect(calls.slice(-2)).toEqual(["exceptions:disable", "resume"]);
  });

  it("steps into app children, over the depth boundary, and out of dependencies", async () => {
    const externalPause: ControllerPause = {
      reason: "step",
      frames: [
        {
          callFrameId: "dependency",
          functionName: "library",
          scriptId: "dependency-script",
          url: "file:///home/vcap/app/node_modules/pkg/index.js",
          lineNumber: 1,
          columnNumber: 0,
        },
        rootFrame(11),
      ],
    };
    const childPause: ControllerPause = {
      reason: "step",
      frames: [
        {
          callFrameId: "child",
          functionName: "child",
          scriptId: "script-child",
          url: "file:///home/vcap/app/dist/child.js",
          lineNumber: 3,
          columnNumber: 0,
        },
        rootFrame(11),
      ],
    };
    const { calls, port } = createPort([
      rootPause(10),
      externalPause,
      childPause,
      { reason: "step", frames: [] },
    ]);

    await recordFunctionTrace(tracePlan(1), {
      timeoutMs: 1_000,
      maxSteps: 10,
      maxPausedMs: 1_000,
      onState: async (): Promise<void> => undefined,
    }, port);

    expect(calls).toContain("step:into");
    expect(calls).toContain("step:out");
    expect(calls).toContain("step:over");
    expect(calls).not.toContain("capture:library");
  });

  it("disarms owned controls before the final resume when state capture fails", async () => {
    const captureError = new Error("capture failed");
    const captureState = vi.fn(async (): Promise<never> => {
      throw captureError;
    });
    const { calls, port } = createPort([rootPause(10)], captureState);

    await expect(recordFunctionTrace(tracePlan(0), {
      timeoutMs: 1_000,
      maxSteps: 10,
      maxPausedMs: 1_000,
      onState: async (): Promise<void> => undefined,
    }, port)).rejects.toBe(captureError);
    expect(calls.slice(-2)).toEqual(["exceptions:disable", "resume"]);
  });

  it("surfaces both the primary failure and an unconfirmed cleanup resume", async () => {
    const captureError = new Error("capture-primary");
    const resumeError = new Error("resume-cleanup");
    const { port } = createPort([rootPause(10)], async (): Promise<never> => {
      throw captureError;
    });
    port.resume = async (): Promise<never> => {
      throw resumeError;
    };

    const failure = await recordFunctionTrace(tracePlan(0), {
      timeoutMs: 1_000,
      maxSteps: 10,
      maxPausedMs: 1_000,
      onState: async (): Promise<void> => undefined,
    }, port).catch((error: unknown): unknown => error);

    expect(failure).toMatchObject({
      code: "CLEANUP_FAILED",
      message: expect.stringContaining("resume could not be confirmed"),
    });
    const cause = Reflect.get(Object(failure), "cause");
    expect(cause).toBeInstanceOf(AggregateError);
    if (!(cause instanceof AggregateError)) {
      throw new Error("cleanup failure cause was not aggregated");
    }
    expect(cause.errors).toEqual([captureError, resumeError]);
  });

  it("stops at the step budget and leaves the target resumed", async () => {
    const { calls, port } = createPort([rootPause(10), rootPause(11)]);

    const result = await recordFunctionTrace(tracePlan(0), {
      timeoutMs: 1_000,
      maxSteps: 1,
      maxPausedMs: 1_000,
      onState: async (): Promise<void> => undefined,
    }, port);

    expect(result.stopReason).toBe("max-steps");
    expect(calls.slice(-2)).toEqual(["exceptions:disable", "resume"]);
  });

  it("stops after returning to a same-line caller outside the function columns", async () => {
    const plan: TracePlan = {
      ...tracePlan(0),
      startLine: 10,
      startColumn: 5,
      endLine: 10,
      endColumn: 15,
    };
    const selected = { ...rootFrame(10), columnNumber: 10 };
    const caller = { ...rootFrame(10, "caller"), columnNumber: 30 };
    const { calls, port } = createPort([
      { reason: "breakpoint", frames: [selected] },
      { reason: "step", frames: [caller] },
    ]);

    const result = await recordFunctionTrace(plan, {
      timeoutMs: 1_000,
      maxSteps: 10,
      maxPausedMs: 1_000,
      onState: async (): Promise<void> => undefined,
    }, port);

    expect(result).toEqual({ stopReason: "function-returned", stepCount: 1 });
    expect(calls.filter((call) => call.startsWith("capture:"))).toEqual(["capture:run"]);
  });

  it("records an exception pause without reporting a normal return", async () => {
    const { calls, port } = createPort([
      rootPause(10),
      { reason: "exception", frames: [rootFrame(12)] },
    ]);
    const records: { readonly kind: string }[] = [];

    const result = await recordFunctionTrace(tracePlan(0), {
      timeoutMs: 1_000,
      maxSteps: 10,
      maxPausedMs: 1_000,
      onState: async (record): Promise<void> => {
        records.push(record);
      },
    }, port);

    expect(result).toEqual({ stopReason: "exception", stepCount: 1 });
    expect(records.map((record) => record.kind)).toEqual(["baseline", "exception"]);
    expect(calls).toContain("exceptions:enable");
    expect(calls.slice(-2)).toEqual(["exceptions:disable", "resume"]);
  });

  it("bounds a hung state capture and immediately resumes the selected isolate", async () => {
    const never = new Promise<never>(() => undefined);
    const { calls, port } = createPort([rootPause(10)], async (): Promise<never> => await never);

    await expect(recordFunctionTrace(tracePlan(0), {
      timeoutMs: 1_000,
      maxSteps: 10,
      maxPausedMs: 20,
      onState: async (): Promise<void> => undefined,
    }, port)).rejects.toMatchObject({ code: "MAX_PAUSED_TIME" });
    expect(calls.slice(-2)).toEqual(["exceptions:disable", "resume"]);
  });

  it("bounds a hung artifact writer while the target is paused", async () => {
    const never = new Promise<never>(() => undefined);
    const { calls, port } = createPort([rootPause(10)]);

    await expect(recordFunctionTrace(tracePlan(0), {
      timeoutMs: 1_000,
      maxSteps: 10,
      maxPausedMs: 20,
      onState: async (): Promise<void> => await never,
    }, port)).rejects.toMatchObject({ code: "MAX_PAUSED_TIME" });
    expect(calls.slice(-2)).toEqual(["exceptions:disable", "resume"]);
  });

  it("bounds breakpoint setup within the overall trace deadline", async () => {
    const never = new Promise<never>(() => undefined);
    const { port } = createPort([]);
    port.setEntryBreakpoint = async (): Promise<never> => await never;

    await expect(recordFunctionTrace(tracePlan(0), {
      timeoutMs: 20,
      maxSteps: 10,
      maxPausedMs: 1_000,
      onState: async (): Promise<void> => undefined,
    }, port)).rejects.toMatchObject({ code: "TRACE_TIMEOUT" });
  });

  it("passes the match condition to the entry breakpoint", async () => {
    const { calls, port } = createPort([rootPause(10), { reason: "step", frames: [] }]);

    await recordFunctionTrace({ ...tracePlan(0), entryCondition: "req.id===1" }, {
      timeoutMs: 1_000,
      maxSteps: 10,
      maxPausedMs: 1_000,
      onState: async (): Promise<void> => undefined,
    }, port);

    expect(calls).toContain("breakpoint:set:req.id===1");
  });

  it("enables async call-stack depth for async plans and resets it on cleanup", async () => {
    const { calls, port } = createPort([rootPause(10), { reason: "step", frames: [] }]);

    await recordFunctionTrace({ ...tracePlan(0), asynchronous: true }, {
      timeoutMs: 1_000,
      maxSteps: 10,
      maxPausedMs: 1_000,
      asyncStackDepth: 6,
      onState: async (): Promise<void> => undefined,
    }, port);

    expect(calls).toContain("async-depth:6");
    expect(calls).toContain("async-depth:0");
    expect(calls.indexOf("async-depth:6")).toBeLessThan(calls.indexOf("async-depth:0"));
  });

  it("resumes and skips a foreign pause while tracing an async activation", async () => {
    const foreignPause: ControllerPause = {
      reason: "exception",
      frames: [{
        callFrameId: "foreign",
        functionName: "unrelated",
        scriptId: "other-script",
        url: "file:///home/vcap/app/dist/other.js",
        lineNumber: 5,
        columnNumber: 0,
      }],
    };
    const { calls, port } = createPort([
      rootPause(10),
      foreignPause,
      rootPause(12),
      { reason: "step", frames: [] },
    ]);

    const result = await recordFunctionTrace({ ...tracePlan(0), asynchronous: true }, {
      timeoutMs: 1_000,
      maxSteps: 10,
      maxPausedMs: 1_000,
      onState: async (): Promise<void> => undefined,
    }, port);

    expect(result.stopReason).toBe("function-returned");
    expect(calls.filter((call) => call === "resume").length).toBeGreaterThanOrEqual(2);
    expect(calls.filter((call) => call.startsWith("capture:"))).toEqual(["capture:run", "capture:run"]);
  });

  it("rejects a concurrent same-function activation through the match predicate", async () => {
    const wrongActivation: ControllerPause = { reason: "exception", frames: [rootFrame(14)] };
    const { calls, port } = createPort(
      [rootPause(10), wrongActivation, rootPause(12), { reason: "step", frames: [] }],
      undefined,
      async (callFrameId): Promise<boolean> => callFrameId !== "root-14",
    );

    const result = await recordFunctionTrace(
      { ...tracePlan(0), asynchronous: true, entryCondition: "req.id===1" },
      {
        timeoutMs: 1_000,
        maxSteps: 10,
        maxPausedMs: 1_000,
        onState: async (): Promise<void> => undefined,
      },
      port,
    );

    expect(result.stopReason).toBe("function-returned");
    expect(calls).toContain("eval:req.id===1");
    expect(calls.filter((call) => call === "resume").length).toBeGreaterThanOrEqual(2);
    expect(calls.filter((call) => call.startsWith("capture:"))).toEqual(["capture:run", "capture:run"]);
  });

  it("rejects fractional and unbounded operation limits", async () => {
    const { port } = createPort([]);
    const common = {
      timeoutMs: 1_000,
      maxSteps: 10,
      maxPausedMs: 1_000,
      onState: async (): Promise<void> => undefined,
    };

    await expect(recordFunctionTrace(tracePlan(0), { ...common, maxSteps: 1.5 }, port))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(recordFunctionTrace(tracePlan(0), { ...common, timeoutMs: Number.POSITIVE_INFINITY }, port))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
