import { describe, expect, it, vi } from "vitest";

import type { InspectorSession } from "../../src/inspector/index.js";
import { walkStack } from "../../src/snapshot/stack.js";
import type { CallFrameInfo } from "../../src/types.js";

function makeSession(
  responder: (method: string, params: Record<string, unknown>) => unknown,
): InspectorSession {
  const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    return responder(method, params);
  });
  return {
    client: { send } as never,
    target: { id: "t", type: "node" } as never,
    scripts: new Map(),
    pauseBuffer: [],
    pauseWaitGate: { active: false },
    debuggerState: {},
    dispose: async (): Promise<void> => undefined,
  };
}

function frame(callFrameId: string, fnName: string, line: number, column = 0): CallFrameInfo {
  return {
    callFrameId,
    functionName: fnName,
    url: `file:///x/${fnName}.js`,
    lineNumber: line,
    columnNumber: column,
    scopeChain: [],
  };
}

describe("walkStack", () => {
  it("returns no frames when stackDepth is 1 (top-frame-only is the default)", async () => {
    const session = makeSession(() => ({ result: { type: "number", value: 1 } }));
    const stack = await walkStack(session, [frame("f0", "deepest", 1)], {
      stackDepth: 1,
      stackCaptures: [],
      maxValueLength: 4096,
    });
    expect(stack).toEqual([]);
  });

  it("walks up to stackDepth frames and 1-indexes line/column for human reading", async () => {
    const session = makeSession(() => ({ result: { type: "number", value: 1 } }));
    const stack = await walkStack(
      session,
      [
        frame("f0", "deepest", 0, 0),
        frame("f1", "middle", 4, 2),
        frame("f2", "outer", 9, 5),
      ],
      { stackDepth: 3, stackCaptures: [], maxValueLength: 4096 },
    );
    expect(stack.map((f) => f.functionName)).toEqual(["deepest", "middle", "outer"]);
    expect(stack[0]?.line).toBe(1);
    expect(stack[0]?.column).toBe(1);
    expect(stack[1]?.line).toBe(5);
    expect(stack[1]?.column).toBe(3);
    expect(stack[2]?.line).toBe(10);
    expect(stack[2]?.column).toBe(6);
  });

  it("clamps stackDepth to the available frame count", async () => {
    const session = makeSession(() => ({ result: { type: "number", value: 1 } }));
    const stack = await walkStack(
      session,
      [frame("f0", "only", 0)],
      { stackDepth: 7, stackCaptures: [], maxValueLength: 4096 },
    );
    // Only one frame available, depth=1 effectively, returns nothing per the
    // top-frame-already-captured rule.
    expect(stack).toEqual([]);
  });

  it("evaluates --stack-captures expressions per frame and routes them to evaluateOnCallFrame", async () => {
    const callsByFrame: Record<string, string[]> = {};
    const session = makeSession((method, params) => {
      if (method === "Debugger.evaluateOnCallFrame") {
        const id = params["callFrameId"] as string;
        const expression = params["expression"] as string;
        callsByFrame[id] ??= [];
        callsByFrame[id].push(expression);
        return { result: { type: "string", value: `${id}:${expression}` } };
      }
      return {};
    });
    const stack = await walkStack(
      session,
      [frame("f0", "deepest", 0), frame("f1", "outer", 0)],
      { stackDepth: 2, stackCaptures: ["this", "args"], maxValueLength: 4096 },
    );
    expect(stack[0]?.captures?.map((c) => c.expression)).toEqual(["this", "args"]);
    expect(stack[1]?.captures?.map((c) => c.expression)).toEqual(["this", "args"]);
    expect(callsByFrame["f0"]).toEqual(["this", "args"]);
    expect(callsByFrame["f1"]).toEqual(["this", "args"]);
  });

  it("captures the per-frame error when evaluation throws synchronously", async () => {
    const session = makeSession((method) => {
      if (method === "Debugger.evaluateOnCallFrame") {
        throw new Error("eval backend down");
      }
      return {};
    });
    const stack = await walkStack(
      session,
      [frame("f0", "deepest", 0), frame("f1", "outer", 0)],
      { stackDepth: 2, stackCaptures: ["x"], maxValueLength: 4096 },
    );
    expect(stack[0]?.captures?.[0]?.error).toContain("eval backend down");
    expect(stack[1]?.captures?.[0]?.error).toContain("eval backend down");
  });
});
