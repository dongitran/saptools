import { describe, expect, it, vi } from "vitest";

import type {
  ExceptionCommandOptions,
  SnapshotCommandOptions,
  Target,
  WatchCommandOptions,
} from "../../src/cli/commandTypes.js";
import { internalsForTesting as exceptionCommandInternals } from "../../src/cli/commands/exception.js";
import { internalsForTesting as snapshotCommandInternals } from "../../src/cli/commands/snapshot.js";
import { internalsForTesting as watchCommandInternals } from "../../src/cli/commands/watch.js";
import type { InspectorSession } from "../../src/inspector/index.js";
import { internalsForTesting as logpointInternals } from "../../src/logpoint/index.js";
import { captureSnapshot } from "../../src/snapshot/capture.js";
import { evalResultToCaptured } from "../../src/snapshot/evaluation.js";
import { walkStack } from "../../src/snapshot/stack.js";
import type { CallFrameInfo, PauseEvent } from "../../src/types.js";

const target: Target = { kind: "port", port: 9229, host: "127.0.0.1" };

function makeSession(
  responder: (method: string, params: Record<string, unknown>) => unknown,
): InspectorSession {
  const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    return responder(method, params);
  });
  return {
    client: { send } as never,
    target: { id: "target", type: "node" } as never,
    scripts: new Map(),
    pauseBuffer: [],
    pauseWaitGate: { active: false },
    debuggerState: {},
    dispose: async (): Promise<void> => void 0,
  };
}

function pauseWithScopes(scopes: CallFrameInfo["scopeChain"]): PauseEvent {
  return {
    reason: "other",
    hitBreakpoints: ["bp-1"],
    callFrames: [{
      callFrameId: "frame-1",
      functionName: "handler",
      url: "file:///app/handler.mjs",
      lineNumber: 4,
      columnNumber: 2,
      scopeChain: scopes,
    }],
  };
}

function snapshotOptions(overrides: Partial<SnapshotCommandOptions> = {}): SnapshotCommandOptions {
  return { bp: ["handler.mjs:5"], json: true, ...overrides };
}

function watchOptions(overrides: Partial<WatchCommandOptions> = {}): WatchCommandOptions {
  return { bp: ["handler.mjs:5"], json: true, ...overrides };
}

function exceptionOptions(
  overrides: Partial<ExceptionCommandOptions> = {},
): ExceptionCommandOptions {
  return { json: true, ...overrides };
}

describe("character truncation metadata", () => {
  it("cuts N+1 characters to exactly N and reports the true length", () => {
    const captured = evalResultToCaptured(
      "payload",
      { result: { type: "object", description: "abcdef" } },
      5,
    );
    expect(captured).toEqual({
      expression: "payload",
      value: "abcde",
      type: "object",
      truncated: true,
      originalLength: 6,
    });
  });

  it("keeps truncation fields absent at the exact limit", () => {
    expect(evalResultToCaptured(
      "payload",
      { result: { type: "object", description: "abcde" } },
      5,
    )).toEqual({ expression: "payload", value: "abcde", type: "object" });
  });

  it("keeps a typical object-sized value under the one-shot default", () => {
    const value = "x".repeat(5_000);
    expect(evalResultToCaptured(
      "payload",
      { result: { type: "object", description: value } },
    )).toEqual({ expression: "payload", value, type: "object" });
  });

  it("annotates evaluation errors that are cut", () => {
    expect(evalResultToCaptured(
      "bad()",
      { exceptionDetails: { text: "abcdef" } },
      5,
    )).toEqual({
      expression: "bad()",
      error: "abcde",
      truncated: true,
      originalLength: 6,
    });
  });

  it("annotates thrown top-frame and stack capture errors", async () => {
    const session = makeSession((method) => {
      if (method === "Debugger.evaluateOnCallFrame") {
        throw new Error("abcdef");
      }
      return { result: [] };
    });
    const pause = pauseWithScopes([]);
    const snapshot = await captureSnapshot(session, pause, {
      captures: ["topFailure"],
      maxValueLength: 5,
    });
    expect(snapshot.captures[0]).toMatchObject({
      error: "abcde",
      truncated: true,
      originalLength: 6,
    });

    const stack = await walkStack(session, [
      pause.callFrames[0] ?? {
        callFrameId: "frame-1",
        functionName: "handler",
        lineNumber: 4,
        columnNumber: 2,
        scopeChain: [],
      },
      {
        callFrameId: "frame-2",
        functionName: "outer",
        lineNumber: 8,
        columnNumber: 0,
        scopeChain: [],
      },
    ], {
      stackDepth: 2,
      stackCaptures: ["stackFailure"],
      maxValueLength: 5,
    });
    expect(stack[0]?.captures?.[0]).toMatchObject({
      error: "abcde",
      truncated: true,
      originalLength: 6,
    });
  });

  it("annotates successful stack-frame values that are cut", async () => {
    const session = makeSession((method) => {
      return method === "Debugger.evaluateOnCallFrame"
        ? { result: { type: "object", description: "abcdef" } }
        : { result: [] };
    });
    const stack = await walkStack(session, [
      {
        callFrameId: "frame-1",
        functionName: "inner",
        lineNumber: 1,
        columnNumber: 0,
        scopeChain: [],
      },
      {
        callFrameId: "frame-2",
        functionName: "outer",
        lineNumber: 2,
        columnNumber: 0,
        scopeChain: [],
      },
    ], {
      stackDepth: 2,
      stackCaptures: ["payload"],
      maxValueLength: 5,
    });
    expect(stack[0]?.captures?.[0]).toEqual({
      expression: "payload",
      value: "abcde",
      type: "object",
      truncated: true,
      originalLength: 6,
    });
  });
});

describe("structural truncation metadata", () => {
  it("marks scope and per-property limits while keeping values as strings", async () => {
    const session = makeSession((method, params) => {
      if (method !== "Runtime.getProperties" || params["objectId"] !== "scope-many") {
        return { result: [] };
      }
      return {
        result: Array.from({ length: 22 }, (_, index) => ({
          name: `value${index.toString()}`,
          value: index === 0
            ? { type: "string", value: "abcdef" }
            : { type: "number", value: index },
        })),
      };
    });
    const snapshot = await captureSnapshot(
      session,
      pauseWithScopes([{ type: "local", objectId: "scope-many" }]),
      { includeScopes: true, maxValueLength: 5 },
    );
    const scope = snapshot.topFrame?.scopes?.[0];
    expect(scope).toMatchObject({ truncated: true, omittedCount: 2 });
    expect(scope?.variables).toHaveLength(20);
    expect(scope?.variables[0]).toMatchObject({
      value: "\"abcd",
      truncated: true,
      originalLength: 8,
    });
    expect(typeof scope?.variables[0]?.value).toBe("string");
  });

  it("marks child-property caps on the owning variable", async () => {
    const session = makeSession((method, params) => {
      if (method !== "Runtime.getProperties") {
        return { result: [] };
      }
      if (params["objectId"] === "scope-root") {
        return {
          result: [{
            name: "payload",
            value: { type: "object", description: "Object", objectId: "payload" },
          }],
        };
      }
      if (params["objectId"] === "payload") {
        return {
          result: Array.from({ length: 10 }, (_, index) => ({
            name: `key${index.toString()}`,
            value: { type: "number", value: index },
          })),
        };
      }
      return { result: [] };
    });
    const snapshot = await captureSnapshot(
      session,
      pauseWithScopes([{ type: "local", objectId: "scope-root" }]),
      { includeScopes: true },
    );
    const payload = snapshot.topFrame?.scopes?.[0]?.variables[0];
    expect(payload).toMatchObject({ truncated: true, omittedCount: 2 });
    expect(payload?.children).toHaveLength(8);
  });

  it("counts properties hidden by the depth cap", async () => {
    const child = (name: string, objectId: string): unknown => ({
      name,
      value: { type: "object", description: "Object", objectId },
    });
    const session = makeSession((method, params) => {
      if (method !== "Runtime.getProperties") {
        return { result: [] };
      }
      const objectId = params["objectId"];
      if (objectId === "scope-depth") {
        return { result: [child("root", "level-1")] };
      }
      if (objectId === "level-1") {
        return { result: [child("child", "level-2")] };
      }
      if (objectId === "level-2") {
        return { result: [child("grandchild", "level-3")] };
      }
      if (objectId === "level-3") {
        return {
          result: Array.from({ length: 3 }, (_, index) => ({
            name: `hidden${index.toString()}`,
            value: { type: "number", value: index },
          })),
        };
      }
      return { result: [] };
    });
    const snapshot = await captureSnapshot(
      session,
      pauseWithScopes([{ type: "local", objectId: "scope-depth" }]),
      { includeScopes: true },
    );
    const grandchild = snapshot.topFrame?.scopes?.[0]
      ?.variables[0]?.children?.[0]?.children?.[0];
    expect(grandchild).toMatchObject({ truncated: true, omittedCount: 3 });
    expect(grandchild?.children).toBeUndefined();
  });

  it("marks omitted scopes on the frame", async () => {
    const session = makeSession(() => ({ result: [] }));
    const scopes = Array.from({ length: 5 }, (_, index) => ({
      type: index === 0 ? "local" : `closure-${index.toString()}`,
      objectId: `scope-${index.toString()}`,
    }));
    const snapshot = await captureSnapshot(session, pauseWithScopes(scopes), {
      includeScopes: true,
    });
    expect(snapshot.topFrame?.scopes).toHaveLength(3);
    expect(snapshot.topFrame).toMatchObject({ truncated: true, omittedCount: 2 });
  });

  it("marks a bare-object capture whose root properties are capped", async () => {
    const session = makeSession((method, params) => {
      if (method === "Debugger.evaluateOnCallFrame") {
        return { result: { type: "object", description: "Object", objectId: "payload" } };
      }
      if (method === "Runtime.getProperties" && params["objectId"] === "payload") {
        return {
          result: Array.from({ length: 22 }, (_, index) => ({
            name: `key${index.toString()}`,
            value: { type: "number", value: index },
          })),
        };
      }
      return { result: [] };
    });
    const snapshot = await captureSnapshot(session, pauseWithScopes([]), {
      captures: ["payload"],
    });
    expect(snapshot.captures[0]).toMatchObject({
      type: "object",
      truncated: true,
      omittedCount: 2,
    });
    expect(typeof snapshot.captures[0]?.value).toBe("string");
  });

  it("applies the character budget only after rendering a bare object", async () => {
    const session = makeSession((method, params) => {
      if (method === "Debugger.evaluateOnCallFrame") {
        return { result: { type: "object", description: "Object", objectId: "payload" } };
      }
      if (method === "Runtime.getProperties" && params["objectId"] === "payload") {
        return {
          result: [{ name: "value", value: { type: "string", value: "abcdefghij" } }],
        };
      }
      return { result: [] };
    });
    const snapshot = await captureSnapshot(session, pauseWithScopes([]), {
      captures: ["payload"],
      maxValueLength: 10,
    });
    expect(snapshot.captures[0]).toMatchObject({
      type: "object",
      truncated: true,
      originalLength: 22,
    });
    expect(snapshot.captures[0]?.value).toHaveLength(10);
    expect(typeof snapshot.captures[0]?.value).toBe("string");
  });
});

describe("tiered command defaults", () => {
  it("uses a large one-shot default and compact streaming default", () => {
    expect(snapshotCommandInternals.prepareSnapshotCommand(
      snapshotOptions(),
      target,
    ).maxValueLength).toBe(131_072);
    expect(exceptionCommandInternals.prepareExceptionCommand(
      exceptionOptions(),
      target,
    ).maxValueLength).toBe(131_072);
    expect(watchCommandInternals.prepareWatchCommand(
      watchOptions(),
      target,
    ).maxValueLength).toBe(4_096);
  });

  it("preserves explicit command limits without a grace margin", () => {
    expect(snapshotCommandInternals.prepareSnapshotCommand(
      snapshotOptions({ maxValueLength: "17" }),
      target,
    ).maxValueLength).toBe(17);
    expect(watchCommandInternals.prepareWatchCommand(
      watchOptions({ maxValueLength: "19" }),
      target,
    ).maxValueLength).toBe(19);
  });

  it("keeps log events compact by default and honors an explicit exact limit", () => {
    const value = "x".repeat(4_097);
    const defaultEvent = logpointInternals.parseLogEvent(
      [
        { type: "string", value: "sentinel" },
        { type: "string", value: JSON.stringify(value) },
      ],
      "sentinel",
      { file: "handler.mjs", line: 5 },
      void 0,
    );
    expect(defaultEvent).toMatchObject({
      value: "x".repeat(4_096),
      truncated: true,
      originalLength: 4_097,
    });

    const exactEvent = logpointInternals.parseLogEvent(
      [
        { type: "string", value: "sentinel" },
        { type: "string", value: JSON.stringify("abcdef") },
      ],
      "sentinel",
      { file: "handler.mjs", line: 5 },
      void 0,
      5,
    );
    expect(exactEvent).toMatchObject({
      value: "abcde",
      truncated: true,
      originalLength: 6,
    });

    const errorEvent = logpointInternals.parseLogEvent(
      [
        { type: "string", value: "sentinel" },
        { type: "string", value: "!err:abcdef" },
      ],
      "sentinel",
      { file: "handler.mjs", line: 5 },
      void 0,
      5,
    );
    expect(errorEvent).toMatchObject({
      error: "abcde",
      truncated: true,
      originalLength: 6,
    });

    const rawEvent = logpointInternals.parseLogEvent(
      [
        { type: "string", value: "sentinel" },
        { type: "string", value: "abcdef" },
      ],
      "sentinel",
      { file: "handler.mjs", line: 5 },
      void 0,
      5,
    );
    expect(rawEvent).toMatchObject({
      value: "abcde",
      raw: "abcde",
      truncated: true,
      originalLength: 6,
    });
  });
});
