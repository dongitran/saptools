import { performance } from "node:perf_hooks";

import { describe, expect, it, vi } from "vitest";

import type { CdpClient } from "../../src/cdp/client.js";
import type { InspectorSession } from "../../src/inspector/index.js";
import {
  evaluateGlobal,
  evaluateOnFrame,
  getProperties,
  removeBreakpoint,
  resume,
  setBreakpoint,
  validateExpression,
  waitForPause,
} from "../../src/inspector/index.js";
import { CfInspectorError } from "../../src/types.js";
import type { PauseEvent } from "../../src/types.js";

function makeSession(buffer: PauseEvent[] = []): {
  session: InspectorSession;
  fireEvent: (params: unknown) => void;
  fireResumed: () => void;
} {
  const listeners = new Map<string, ((p: unknown) => void)[]>();
  const fire = (method: string, params: unknown): void => {
    const list = listeners.get(method) ?? [];
    for (const fn of list) {
      fn(params);
    }
  };
  const fireEvent = (params: unknown): void => {
    fire("Debugger.paused", params);
  };
  const fireResumed = (): void => {
    fire("Debugger.resumed", {});
  };
  const client = {
    waitFor: vi.fn(async (method: string, options: { timeoutMs: number; predicate?: (p: unknown) => boolean }) => {
      return await new Promise<unknown>((resolve, reject) => {
        const off = ((): (() => void) => {
          const wrapped = (raw: unknown): void => {
            if (options.predicate && !options.predicate(raw)) {
              return;
            }
            cleanup();
            resolve(raw);
          };
          const list = listeners.get(method) ?? [];
          list.push(wrapped);
          listeners.set(method, list);
          return (): void => {
            const next = (listeners.get(method) ?? []).filter((fn) => fn !== wrapped);
            listeners.set(method, next);
          };
        })();
        const timer = setTimeout(() => {
          cleanup();
          reject(new CfInspectorError("BREAKPOINT_NOT_HIT", `timed out after ${options.timeoutMs.toString()}ms`));
        }, options.timeoutMs);
        function cleanup(): void {
          clearTimeout(timer);
          off();
        }
      });
    }),
  } as unknown as CdpClient;
  const session: InspectorSession = {
    client,
    target: { id: "t", type: "node" } as never,
    scripts: new Map(),
    pauseBuffer: [...buffer],
    pauseWaitGate: { active: false },
    debuggerState: {},
    dispose: async (): Promise<void> => undefined,
  };
  return { session, fireEvent, fireResumed };
}

describe("waitForPause", () => {
  it("drains a pre-buffered matching event without awaiting a new one", async () => {
    const { session } = makeSession([
      {
        reason: "other",
        hitBreakpoints: ["bp-1"],
        callFrames: [],
        receivedAtMs: 123,
      },
    ]);
    const result = await waitForPause(session, { timeoutMs: 50, breakpointIds: ["bp-1"] });
    expect(result.hitBreakpoints).toEqual(["bp-1"]);
    expect(result.receivedAtMs).toBe(123);
    expect(session.pauseBuffer).toHaveLength(0);
  });

  it("reports a dedicated timeout when a buffered unmatched pause never resumes", async () => {
    const { session } = makeSession([
      {
        reason: "other",
        hitBreakpoints: ["bp-other"],
        callFrames: [],
      },
    ]);
    await expect(
      waitForPause(session, { timeoutMs: 30, breakpointIds: ["bp-1"] }),
    ).rejects.toMatchObject({ code: "UNRELATED_PAUSE_TIMEOUT" });
  });

  it("returns the first buffered event when no breakpointIds filter is given", async () => {
    const { session } = makeSession([
      { reason: "step", hitBreakpoints: [], callFrames: [] },
      { reason: "other", hitBreakpoints: ["bp-2"], callFrames: [] },
    ]);
    const result = await waitForPause(session, { timeoutMs: 50 });
    expect(result.reason).toBe("step");
    // one event was consumed; second remains buffered for a future call
    expect(session.pauseBuffer).toHaveLength(1);
  });

  it("waits on the live CDP event when buffer is empty", async () => {
    const { session, fireEvent } = makeSession([]);
    const before = performance.now();
    const promise = waitForPause(session, { timeoutMs: 200, breakpointIds: ["bp-7"] });
    setTimeout(() => {
      fireEvent({
        reason: "other",
        hitBreakpoints: ["bp-7"],
        callFrames: [
          {
            callFrameId: "f1",
            functionName: "fn",
            url: "file:///x.js",
            location: { lineNumber: 10, columnNumber: 0 },
            scopeChain: [],
          },
        ],
      });
    }, 5);
    const result = await promise;
    expect(result.reason).toBe("other");
    expect(result.hitBreakpoints).toEqual(["bp-7"]);
    expect(result.callFrames).toHaveLength(1);
    expect(result.callFrames[0]?.functionName).toBe("fn");
    expect(result.receivedAtMs).toBeDefined();
    const receivedAtMs = result.receivedAtMs ?? 0;
    expect(receivedAtMs).toBeGreaterThanOrEqual(before);
    expect(receivedAtMs).toBeLessThanOrEqual(performance.now());
  });

  it("ignores live events whose breakpointId is not in the filter", async () => {
    const { session, fireEvent, fireResumed } = makeSession([]);
    const promise = waitForPause(session, { timeoutMs: 100, breakpointIds: ["bp-9"] });
    setTimeout(() => {
      fireEvent({ reason: "other", hitBreakpoints: ["bp-other"], callFrames: [] });
    }, 5);
    setTimeout(() => {
      fireResumed();
    }, 15);
    await expect(promise).rejects.toThrow();
  });

  it("waits cooperatively through an unmatched pause and then returns a matching pause", async () => {
    const { session, fireEvent, fireResumed } = makeSession([]);
    const unmatched: PauseEvent[] = [];
    const promise = waitForPause(session, {
      timeoutMs: 300,
      breakpointIds: ["bp-1"],
      onUnmatchedPause: (pause) => {
        unmatched.push(pause);
      },
    });
    setTimeout(() => {
      fireEvent({ reason: "debuggerStatement", hitBreakpoints: [], callFrames: [] });
    }, 5);
    setTimeout(() => {
      fireResumed();
    }, 20);
    setTimeout(() => {
      fireEvent({ reason: "other", hitBreakpoints: ["bp-1"], callFrames: [] });
    }, 35);
    const result = await promise;
    expect(result.hitBreakpoints).toEqual(["bp-1"]);
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]?.reason).toBe("debuggerStatement");
  });

  it("fails immediately on unmatched pauses in strict mode", async () => {
    const { session, fireEvent } = makeSession([]);
    const promise = waitForPause(session, {
      timeoutMs: 300,
      breakpointIds: ["bp-1"],
      unmatchedPausePolicy: "fail",
    });
    setTimeout(() => {
      fireEvent({ reason: "debuggerStatement", hitBreakpoints: [], callFrames: [] });
    }, 5);
    await expect(promise).rejects.toMatchObject({ code: "UNRELATED_PAUSE" });
  });

  it("does not wait for resume when a buffered unmatched pause already resumed", async () => {
    const { session, fireEvent } = makeSession([
      {
        reason: "debuggerStatement",
        hitBreakpoints: [],
        callFrames: [],
        receivedAtMs: 10,
      },
    ]);
    session.debuggerState.lastResumedAtMs = 20;
    const promise = waitForPause(session, { timeoutMs: 300, breakpointIds: ["bp-1"] });
    setTimeout(() => {
      fireEvent({ reason: "other", hitBreakpoints: ["bp-1"], callFrames: [] });
    }, 5);
    await expect(promise).resolves.toMatchObject({ hitBreakpoints: ["bp-1"] });
  });

  it("flips pauseWaitGate.active on while waiting and back off after the live event resolves", async () => {
    const { session, fireEvent } = makeSession([]);
    expect(session.pauseWaitGate.active).toBe(false);
    const promise = waitForPause(session, { timeoutMs: 200, breakpointIds: ["bp-1"] });
    // Yield once so waitForPause reaches the live-mode branch and flips the gate.
    await new Promise<void>((r) => setImmediate(r));
    expect(session.pauseWaitGate.active).toBe(true);
    fireEvent({ reason: "other", hitBreakpoints: ["bp-1"], callFrames: [] });
    await promise;
    expect(session.pauseWaitGate.active).toBe(false);
  });

  it("leaves the gate off when the buffered match path returns synchronously", async () => {
    const { session } = makeSession([
      { reason: "other", hitBreakpoints: ["bp-1"], callFrames: [] },
    ]);
    await waitForPause(session, { timeoutMs: 50, breakpointIds: ["bp-1"] });
    // The gate is only flipped on the live-mode branch; a buffer hit must not
    // touch it. Otherwise consecutive buffered hits would gate each other.
    expect(session.pauseWaitGate.active).toBe(false);
  });

  it("releases the gate even when the live wait rejects on timeout", async () => {
    const { session } = makeSession([]);
    await expect(
      waitForPause(session, { timeoutMs: 30, breakpointIds: ["bp-x"] }),
    ).rejects.toThrow();
    expect(session.pauseWaitGate.active).toBe(false);
  });
});

interface SendCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function makeSendSession(
  responder: (call: SendCall) => unknown,
): { session: InspectorSession; calls: SendCall[] } {
  const calls: SendCall[] = [];
  const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    const call: SendCall = { method, params };
    calls.push(call);
    return responder(call);
  });
  const session: InspectorSession = {
    client: { send } as unknown as CdpClient,
    target: { id: "t", type: "node" } as never,
    scripts: new Map(),
    pauseBuffer: [],
    pauseWaitGate: { active: false },
    debuggerState: {},
    dispose: async (): Promise<void> => undefined,
  };
  return { session, calls };
}

describe("setBreakpoint", () => {
  it("calls Debugger.setBreakpointByUrl with the urlRegex derived from file/line and a 0-indexed lineNumber", async () => {
    const { session, calls } = makeSendSession((_call) => ({
      breakpointId: "bp-42",
      locations: [
        { scriptId: "s-1", url: "file:///app/src/handler.js", lineNumber: 41, columnNumber: 0 },
      ],
    }));
    const handle = await setBreakpoint(session, {
      file: "src/handler.ts",
      line: 42,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("Debugger.setBreakpointByUrl");
    expect(calls[0]?.params["lineNumber"]).toBe(41);
    expect(typeof calls[0]?.params["urlRegex"]).toBe("string");
    expect(handle.breakpointId).toBe("bp-42");
    expect(handle.line).toBe(42);
    expect(handle.resolvedLocations).toHaveLength(1);
    expect(handle.resolvedLocations[0]?.scriptId).toBe("s-1");
  });

  it("forwards an optional condition into the CDP params", async () => {
    const { calls, session } = makeSendSession(() => ({ breakpointId: "bp-1", locations: [] }));
    await setBreakpoint(session, {
      file: "src/handler.ts",
      line: 1,
      condition: "req.userId === 'foo'",
    });
    expect(calls[0]?.params["condition"]).toBe("req.userId === 'foo'");
  });

  it("returns a handle with empty resolvedLocations when CDP did not bind the breakpoint", async () => {
    const { session } = makeSendSession(() => ({ breakpointId: "bp-1", locations: [] }));
    const handle = await setBreakpoint(session, { file: "wrong/path.ts", line: 1 });
    expect(handle.resolvedLocations).toEqual([]);
  });

  it("throws CDP_REQUEST_FAILED when CDP omits the breakpointId", async () => {
    const { session } = makeSendSession(() => ({ locations: [] }));
    await expect(setBreakpoint(session, { file: "x.ts", line: 1 })).rejects.toThrowError(
      CfInspectorError,
    );
  });
});

describe("removeBreakpoint", () => {
  it("calls Debugger.removeBreakpoint with the supplied id", async () => {
    const { session, calls } = makeSendSession(() => ({}));
    await removeBreakpoint(session, "bp-1");
    expect(calls[0]?.method).toBe("Debugger.removeBreakpoint");
    expect(calls[0]?.params["breakpointId"]).toBe("bp-1");
  });
});

describe("resume", () => {
  it("calls Debugger.resume", async () => {
    const { session, calls } = makeSendSession(() => ({}));
    await resume(session);
    expect(calls[0]?.method).toBe("Debugger.resume");
  });
});

describe("evaluateOnFrame / evaluateGlobal / getProperties", () => {
  it("evaluateOnFrame routes via Debugger.evaluateOnCallFrame with silent: true", async () => {
    const { session, calls } = makeSendSession(() => ({ result: { type: "string", value: "ok" } }));
    await evaluateOnFrame(session, "frame-1", "1+1");
    expect(calls[0]?.method).toBe("Debugger.evaluateOnCallFrame");
    expect(calls[0]?.params["callFrameId"]).toBe("frame-1");
    expect(calls[0]?.params["expression"]).toBe("1+1");
    expect(calls[0]?.params["silent"]).toBe(true);
  });

  it("evaluateGlobal routes via Runtime.evaluate with silent: true", async () => {
    const { session, calls } = makeSendSession(() => ({ result: { type: "string", value: "ok" } }));
    await evaluateGlobal(session, "1+1");
    expect(calls[0]?.method).toBe("Runtime.evaluate");
    expect(calls[0]?.params["silent"]).toBe(true);
  });

  it("getProperties parses out the result array", async () => {
    const { session, calls } = makeSendSession(() => ({
      result: [
        { name: "a", value: { type: "number", value: 1 } },
        { name: "b", value: { type: "number", value: 2 } },
      ],
    }));
    const props = await getProperties(session, "obj-7");
    expect(calls[0]?.method).toBe("Runtime.getProperties");
    expect(calls[0]?.params["objectId"]).toBe("obj-7");
    expect(props).toHaveLength(2);
  });

  it("getProperties returns an empty array when CDP returns a non-array", async () => {
    const { session } = makeSendSession(() => ({ result: undefined }));
    const props = await getProperties(session, "obj-x");
    expect(props).toEqual([]);
  });
});

describe("validateExpression", () => {
  it("resolves when CDP reports no exceptionDetails", async () => {
    const { session, calls } = makeSendSession(() => ({ scriptId: "s-1" }));
    await expect(validateExpression(session, "1+1")).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe("Runtime.compileScript");
    expect(calls[0]?.params["expression"]).toBe("1+1");
    expect(calls[0]?.params["persistScript"]).toBe(false);
  });

  it("throws INVALID_EXPRESSION with the exception.description when V8 reports a SyntaxError", async () => {
    const { session } = makeSendSession(() => ({
      exceptionDetails: { exception: { description: "SyntaxError: Unexpected token ')'" } },
    }));
    await expect(validateExpression(session, "1+)")).rejects.toMatchObject({
      code: "INVALID_EXPRESSION",
      message: expect.stringContaining("SyntaxError") as unknown as string,
    });
  });

  it("falls back to exceptionDetails.text when no exception object is present", async () => {
    const { session } = makeSendSession(() => ({
      exceptionDetails: { text: "compile failed" },
    }));
    await expect(validateExpression(session, "")).rejects.toMatchObject({
      code: "INVALID_EXPRESSION",
      message: "compile failed",
    });
  });

  it("uses a sentinel sourceURL so the validation script is identifiable in CDP logs", async () => {
    const { session, calls } = makeSendSession(() => ({ scriptId: "s-1" }));
    await validateExpression(session, "x");
    expect(calls[0]?.params["sourceURL"]).toBe("<cf-inspector-validate>");
  });
});
