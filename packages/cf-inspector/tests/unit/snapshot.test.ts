import { describe, expect, it, vi } from "vitest";

import type { CdpEvalResult, CdpProperty, InspectorSession } from "../../src/inspector/index.js";
import { captureSnapshot, internalsForTesting } from "../../src/snapshot/capture.js";
import type { CallFrameInfo, PauseEvent } from "../../src/types.js";

const { limitValueLength, describeProperty, selectScopes, evalResultToCaptured } = internalsForTesting;

describe("limitValueLength", () => {
  it("truncates values longer than the default limit", () => {
    const long = "x".repeat(5000);
    const out = limitValueLength(long);
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(4099);
  });

  it("truncates values longer than a custom limit", () => {
    expect(limitValueLength("abcdef", 3)).toBe("abc...");
  });

  it("returns short values unchanged regardless of name", () => {
    expect(limitValueLength("42")).toBe("42");
    expect(limitValueLength("hunter2")).toBe("hunter2");
  });
});

describe("describeProperty", () => {
  it("formats string values as JSON-quoted strings", () => {
    const prop: CdpProperty = { name: "n", value: { type: "string", value: "hi" } };
    expect(describeProperty(prop)).toEqual({ value: '"hi"', type: "string" });
  });

  it("formats numeric primitives as their string form", () => {
    const prop: CdpProperty = { name: "n", value: { type: "number", value: 42 } };
    expect(describeProperty(prop)).toEqual({ value: "42", type: "number" });
  });

  it("preserves the description for objects", () => {
    const prop: CdpProperty = {
      name: "n",
      value: { type: "object", description: "User { id: 1 }", objectId: "obj-1" },
    };
    expect(describeProperty(prop)).toEqual({
      value: "User { id: 1 }",
      type: "object",
      objectId: "obj-1",
    });
  });

  it("returns undefined when value is missing", () => {
    expect(describeProperty({ name: "n" })).toEqual({ value: "undefined" });
  });
});

describe("selectScopes", () => {
  it("drops global scopes and orders by priority", () => {
    const chain: CallFrameInfo["scopeChain"] = [
      { type: "global", objectId: "g" },
      { type: "closure", objectId: "c" },
      { type: "local", objectId: "l" },
      { type: "block", objectId: "b" },
      { type: "module", objectId: "m" },
    ];
    const out = selectScopes(chain).map((s) => s.type);
    expect(out).toEqual(["local", "block", "closure"]);
  });

  it("drops scopes without objectId", () => {
    const chain: CallFrameInfo["scopeChain"] = [
      { type: "local" },
      { type: "closure", objectId: "c" },
    ];
    const out = selectScopes(chain).map((s) => s.type);
    expect(out).toEqual(["closure"]);
  });
});

describe("captureSnapshot", () => {
  const localScopeId = "scope-local";
  const argScopeId = "scope-args";
  const userObjectId = "obj-user";
  const credentialObjectId = "obj-credential";
  const emptyArrayObjectId = "obj-empty-array";
  const mapLikeObjectId = "obj-map-like";

  function makeSession(): InspectorSession {
    const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "Runtime.getProperties") {
        const objectId = params["objectId"];
        if (objectId === localScopeId) {
          return {
            result: [
              { name: "userId", value: { type: "number", value: 7 } },
              { name: "user", value: { type: "object", description: "{ id: 7 }", objectId: userObjectId } },
              { name: "password", value: { type: "string", value: "leak-me-not" } },
              {
                name: "credentials",
                value: { type: "object", description: "{ value: 'hidden' }", objectId: credentialObjectId },
              },
            ],
          };
        }
        if (objectId === argScopeId) {
          return {
            result: [
              { name: "req", value: { type: "object", description: "{ url: '/' }" } },
            ],
          };
        }
        if (objectId === userObjectId) {
          return {
            result: [
              { name: "id", value: { type: "number", value: 7 } },
              { name: "token", value: { type: "string", value: "abc-123" } },
            ],
          };
        }
        if (objectId === credentialObjectId) {
          return {
            result: [
              { name: "value", value: { type: "string", value: "must-not-expand" } },
            ],
          };
        }
        if (objectId === emptyArrayObjectId) {
          return {
            result: [
              { name: "length", value: { type: "number", value: 0 } },
            ],
          };
        }
        if (objectId === mapLikeObjectId) {
          return { result: [] };
        }
        return { result: [] };
      }
      if (method === "Debugger.evaluateOnCallFrame") {
        const expression = params["expression"];
        if (expression === "user.id") {
          return { result: { type: "number", value: 7 } };
        }
        if (expression === "user") {
          return {
            result: { type: "object", description: "Object", objectId: userObjectId },
          };
        }
        if (expression === "emptyArr") {
          return {
            result: { type: "object", description: "Array(0)", objectId: emptyArrayObjectId },
          };
        }
        if (expression === "mapLike") {
          return {
            result: { type: "object", description: "Map(1)", objectId: mapLikeObjectId },
          };
        }
        if (expression === "throwy") {
          return {
            exceptionDetails: { exception: { description: "ReferenceError: throwy is not defined" } },
          };
        }
        return { result: { type: "undefined" } };
      }
      return {};
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

  function makePauseEvent(): PauseEvent {
    return {
      reason: "other",
      hitBreakpoints: ["bp:1"],
      callFrames: [
        {
          callFrameId: "f1",
          functionName: "handle",
          url: "file:///app/src/handler.ts",
          lineNumber: 41,
          columnNumber: 4,
          scopeChain: [
            { type: "local", objectId: localScopeId },
            { type: "arguments", objectId: argScopeId },
            { type: "global", objectId: "scope-global" },
          ],
        },
      ],
    };
  }

  it("omits scopes by default while still returning frame metadata and captures", async () => {
    const snapshot = await captureSnapshot(makeSession(), makePauseEvent(), {
      captures: ["user.id"],
    });
    expect(snapshot.topFrame).toEqual({
      functionName: "handle",
      url: "file:///app/src/handler.ts",
      line: 42,
      column: 5,
    });
    expect(snapshot.captures[0]).toMatchObject({
      expression: "user.id",
      value: "7",
      type: "number",
    });
  });

  it("captures scopes and preserves sensitive-looking variable names when requested", async () => {
    const snapshot = await captureSnapshot(makeSession(), makePauseEvent(), {
      captures: ["user.id", "throwy"],
      includeScopes: true,
    });
    expect(snapshot.reason).toBe("other");
    expect("captureDurationMs" in snapshot).toBe(false);
    expect("pausedDurationMs" in snapshot).toBe(false);
    expect(snapshot.hitBreakpoints).toEqual(["bp:1"]);
    expect(snapshot.topFrame).toBeDefined();
    expect(snapshot.topFrame?.line).toBe(42);
    expect(snapshot.topFrame?.column).toBe(5);
    expect(snapshot.topFrame?.scopes).toHaveLength(2);

    const localScope = snapshot.topFrame?.scopes?.find((s) => s.type === "local");
    expect(localScope).toBeDefined();
    const password = localScope?.variables.find((v) => v.name === "password");
    expect(password?.value).toBe("\"leak-me-not\"");
    const credentials = localScope?.variables.find((v) => v.name === "credentials");
    expect(credentials?.value).toBe("{ value: 'hidden' }");
    expect(credentials?.children?.find((child) => child.name === "value")?.value).toBe("\"must-not-expand\"");
    const userVar = localScope?.variables.find((v) => v.name === "user");
    expect(userVar?.children?.find((c) => c.name === "token")?.value).toBe("\"abc-123\"");

    const captures = Object.fromEntries(
      snapshot.captures.map((c) => [c.expression, c.value ?? c.error]),
    );
    expect(captures["user.id"]).toBe("7");
    expect(captures["throwy"]).toContain("ReferenceError");
  });

  it("returns an empty topFrame when no call frames are present", async () => {
    const snapshot = await captureSnapshot(makeSession(), {
      reason: "other",
      hitBreakpoints: [],
      callFrames: [],
    });
    expect(snapshot.topFrame).toBeUndefined();
    expect(snapshot.captures).toEqual([]);
  });

  it("records a capture error when evaluateOnFrame throws", async () => {
    const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "Runtime.getProperties") {
        return { result: [] };
      }
      if (method === "Debugger.evaluateOnCallFrame") {
        const expression = params["expression"];
        if (expression === "boom") {
          throw new Error("network down");
        }
      }
      return { result: { type: "undefined" } };
    });
    const session = {
      client: { send } as never,
      target: { id: "t", type: "node" } as never,
      scripts: new Map(),
      pauseBuffer: [],
      pauseWaitGate: { active: false },
      debuggerState: {},
      dispose: async (): Promise<void> => undefined,
    };
    const pause: PauseEvent = {
      reason: "other",
      hitBreakpoints: [],
      callFrames: [
        {
          callFrameId: "f1",
          functionName: "x",
          url: "file:///x.js",
          lineNumber: 0,
          columnNumber: 0,
          scopeChain: [{ type: "local", objectId: "scope-1" }],
        },
      ],
    };
    const snapshot = await captureSnapshot(session, pause, { captures: ["boom"] });
    expect(snapshot.captures[0]?.error).toContain("network down");
  });

  it("keeps readable scopes when one top-level scope property read fails", async () => {
    const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "Runtime.getProperties") {
        const objectId = params["objectId"];
        if (objectId === "scope-local") {
          throw new Error("scope backend down");
        }
        if (objectId === "scope-args") {
          return {
            result: [
              { name: "requestId", value: { type: "string", value: "r-1" } },
            ],
          };
        }
      }
      return { result: [] };
    });
    const session = {
      client: { send } as never,
      target: { id: "t", type: "node" } as never,
      scripts: new Map(),
      pauseBuffer: [],
      pauseWaitGate: { active: false },
      debuggerState: {},
      dispose: async (): Promise<void> => undefined,
    };
    const pause: PauseEvent = {
      reason: "other",
      hitBreakpoints: [],
      callFrames: [
        {
          callFrameId: "f1",
          functionName: "x",
          url: "file:///x.js",
          lineNumber: 0,
          columnNumber: 0,
          scopeChain: [
            { type: "local", objectId: "scope-local" },
            { type: "arguments", objectId: "scope-args" },
          ],
        },
      ],
    };

    const snapshot = await captureSnapshot(session, pause, { includeScopes: true });
    const localScope = snapshot.topFrame?.scopes?.find((scope) => scope.type === "local");
    const argScope = snapshot.topFrame?.scopes?.find((scope) => scope.type === "arguments");
    expect(localScope?.variables).toEqual([]);
    expect(argScope?.variables[0]?.name).toBe("requestId");
    expect(argScope?.variables[0]?.value).toBe('"r-1"');
  });

  it("does not report paused duration because resume happens outside captureSnapshot", async () => {
    const sendOrder: string[] = [];
    const send = vi.fn(async (method: string) => {
      sendOrder.push(method);
      if (method === "Runtime.getProperties") {
        return { result: [] };
      }
      if (method === "Debugger.evaluateOnCallFrame") {
        return { result: { type: "number", value: 1 } };
      }
      return {};
    });
    const session = {
      client: { send } as never,
      target: { id: "t", type: "node" } as never,
      scripts: new Map(),
      pauseBuffer: [],
      pauseWaitGate: { active: false },
      debuggerState: {},
      dispose: async (): Promise<void> => undefined,
    };
    const pause: PauseEvent = {
      reason: "other",
      hitBreakpoints: [],
      callFrames: [
        {
          callFrameId: "f1",
          functionName: "x",
          url: "file:///x.js",
          lineNumber: 0,
          columnNumber: 0,
          scopeChain: [{ type: "local", objectId: "scope-1" }],
        },
      ],
    };
    const snapshot = await captureSnapshot(session, pause, { captures: ["one"] });
    expect("captureDurationMs" in snapshot).toBe(false);
    expect("pausedDurationMs" in snapshot).toBe(false);
    expect(snapshot.topFrame).toEqual({
      functionName: "x",
      url: "file:///x.js",
      line: 1,
      column: 1,
    });
    expect(sendOrder).toEqual(["Debugger.evaluateOnCallFrame"]);
  });

  it("renders object captures as JSON when object serialization succeeds", async () => {
    const snapshot = await captureSnapshot(makeSession(), makePauseEvent(), {
      captures: ["user"],
    });
    const userCapture = snapshot.captures[0];
    expect(userCapture?.type).toBe("object");
    const parsed = JSON.parse(userCapture?.value ?? "{}") as { id?: number; token?: string };
    expect(parsed.id).toBe(7);
    expect(parsed.token).toBe("abc-123");
  });

  it("honors a custom max value length for object captures", async () => {
    const snapshot = await captureSnapshot(makeSession(), makePauseEvent(), {
      captures: ["user"],
      maxValueLength: 20,
    });
    const value = snapshot.captures[0]?.value ?? "";
    expect(value.endsWith("...")).toBe(true);
    expect(value.length).toBeLessThanOrEqual(23);
  });

  it("rejects invalid max value length overrides", async () => {
    await expect(
      captureSnapshot(makeSession(), makePauseEvent(), {
        captures: ["user"],
        maxValueLength: 0,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("falls back to the object description when serialization fails", async () => {
    const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "Runtime.getProperties") {
        const objectId = params["objectId"];
        if (objectId === "scope-1") {
          return { result: [] };
        }
        if (objectId === "payload-1") {
          throw new Error("property backend unavailable");
        }
        return { result: [] };
      }
      if (method === "Debugger.evaluateOnCallFrame") {
        if (params["expression"] === "payload") {
          return {
            result: { type: "object", description: "Object", objectId: "payload-1" },
          };
        }
        return { result: { type: "undefined" } };
      }
      return {};
    });
    const session = {
      client: { send } as never,
      target: { id: "t", type: "node" } as never,
      scripts: new Map(),
      pauseBuffer: [],
      pauseWaitGate: { active: false },
      debuggerState: {},
      dispose: async (): Promise<void> => undefined,
    };
    const pause: PauseEvent = {
      reason: "other",
      hitBreakpoints: [],
      callFrames: [
        {
          callFrameId: "f1",
          functionName: "x",
          url: "file:///x.js",
          lineNumber: 0,
          columnNumber: 0,
          scopeChain: [{ type: "local", objectId: "scope-1" }],
        },
      ],
    };
    const snapshot = await captureSnapshot(session, pause, { captures: ["payload"] });
    expect(snapshot.captures[0]).toEqual({
      expression: "payload",
      value: "Object",
      type: "object",
    });
  });

  it("renders empty arrays as [] for captured object expressions", async () => {
    const snapshot = await captureSnapshot(makeSession(), makePauseEvent(), {
      captures: ["emptyArr"],
    });
    expect(snapshot.captures[0]).toEqual({
      expression: "emptyArr",
      value: "[]",
      type: "object",
    });
  });

  it("keeps non-generic object descriptions when expansion is empty", async () => {
    const snapshot = await captureSnapshot(makeSession(), makePauseEvent(), {
      captures: ["mapLike"],
    });
    expect(snapshot.captures[0]).toEqual({
      expression: "mapLike",
      value: "Map(1)",
      type: "object",
    });
  });
});

describe("evalResultToCaptured", () => {
  it("returns the resulting string value", () => {
    const result: CdpEvalResult = { result: { type: "string", value: "ok" } };
    expect(evalResultToCaptured("expr", result)).toEqual({
      expression: "expr",
      value: '"ok"',
      type: "string",
    });
  });

  it("keeps sensitive-looking expressions unchanged", () => {
    const result: CdpEvalResult = { result: { type: "string", value: "secret" } };
    const out = evalResultToCaptured("password", result);
    expect(out.value).toBe("\"secret\"");
  });

  it("includes the exception description on errors", () => {
    const result: CdpEvalResult = {
      exceptionDetails: { exception: { description: "ReferenceError: foo is not defined" } },
    };
    const out = evalResultToCaptured("foo", result);
    expect(out.error).toContain("ReferenceError");
  });

  it("keeps exception text for sensitive-looking expressions", () => {
    const result: CdpEvalResult = {
      exceptionDetails: { exception: { description: "Error: secret value" } },
    };
    const out = evalResultToCaptured("password", result);
    expect(out.error).toBe("Error: secret value");
  });

  it("falls back to inner.description for object values", () => {
    const result: CdpEvalResult = { result: { type: "object", description: "{ a: 1 }" } };
    expect(evalResultToCaptured("expr", result)).toEqual({
      expression: "expr",
      value: "{ a: 1 }",
      type: "object",
    });
  });

  it("returns 'no result returned' when both result and exceptionDetails are missing", () => {
    expect(evalResultToCaptured("expr", {})).toEqual({
      expression: "expr",
      error: "no result returned",
    });
  });

  it("falls back to exception text when exception.description is missing", () => {
    const result: CdpEvalResult = { exceptionDetails: { text: "plain failure" } };
    expect(evalResultToCaptured("expr", result).error).toBe("plain failure");
  });

  it("returns 'evaluation failed' when neither description nor text is present", () => {
    const result: CdpEvalResult = { exceptionDetails: {} };
    expect(evalResultToCaptured("expr", result).error).toBe("evaluation failed");
  });

  it("returns 'undefined' when nothing matches a known shape", () => {
    const result: CdpEvalResult = { result: { type: "object" } };
    expect(evalResultToCaptured("expr", result)).toEqual({
      expression: "expr",
      value: "undefined",
      type: "object",
    });
  });

  it("captures bigint primitives via the type-driven branch", () => {
    const result: CdpEvalResult = { result: { type: "bigint", value: 7n } };
    expect(evalResultToCaptured("expr", result)).toEqual({
      expression: "expr",
      value: "7n",
      type: "bigint",
    });
  });
});
