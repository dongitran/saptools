// cspell:words trustedtype wasmvalue webassemblymemory
import { describe, expect, it, vi } from "vitest";

import type { CdpClient } from "../../src/cdp/client.js";
import {
  toPauseEvent,
  toRemoteObject,
  toScriptInfo,
  toScriptLocation,
} from "../../src/inspector/conversions.js";
import {
  getPossibleBreakpoints,
  getScriptSource,
  releaseObject,
  releaseObjectGroup,
  setBreakpointAtLocation,
  stepInto,
  stepOut,
  stepOver,
  waitForPause,
} from "../../src/inspector/index.js";
import { evaluateOnFrame } from "../../src/inspector/runtime.js";
import type { InspectorSession } from "../../src/inspector/types.js";
import { CfInspectorError } from "../../src/types.js";
import type { PauseEvent } from "../../src/types.js";

interface SendCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function makeSendSession(
  responder: (call: SendCall) => unknown,
): { readonly session: InspectorSession; readonly calls: readonly SendCall[] } {
  const calls: SendCall[] = [];
  const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    const call = { method, params };
    calls.push(call);
    return responder(call);
  });
  const session: InspectorSession = {
    client: { send } as unknown as CdpClient,
    target: { id: "target", type: "node" } as never,
    scripts: new Map(),
    pauseBuffer: [],
    pauseWaitGate: { active: false },
    debuggerState: {},
    dispose: async (): Promise<void> => undefined,
  };
  return { session, calls };
}

describe("CDP protocol wrappers", () => {
  it("retrieves the exact runtime source for a loaded script", async () => {
    const { calls, session } = makeSendSession(() => ({ scriptSource: "export const loaded = true;" }));

    await expect(getScriptSource(session, "script-7")).resolves.toBe("export const loaded = true;");
    expect(calls).toEqual([{ method: "Debugger.getScriptSource", params: { scriptId: "script-7" } }]);
  });

  it("fails closed when getScriptSource omits its result field", async () => {
    const { session } = makeSendSession(() => ({}));

    await expect(getScriptSource(session, "script-7")).rejects.toMatchObject({
      code: "CDP_REQUEST_FAILED",
    });
  });

  it("returns possible break locations with CDP zero-based coordinates", async () => {
    const { calls, session } = makeSendSession(() => ({
      locations: [
        { scriptId: "script-7", lineNumber: 10, columnNumber: 4, type: "call" },
        { scriptId: "script-7", lineNumber: 11, columnNumber: 2, type: "return" },
      ],
    }));

    const locations = await getPossibleBreakpoints(session, {
      start: { scriptId: "script-7", lineNumber: 10, columnNumber: 0 },
      end: { scriptId: "script-7", lineNumber: 14, columnNumber: 0 },
      restrictToFunction: true,
    });

    expect(calls[0]).toEqual({
      method: "Debugger.getPossibleBreakpoints",
      params: {
        start: { scriptId: "script-7", lineNumber: 10, columnNumber: 0 },
        end: { scriptId: "script-7", lineNumber: 14, columnNumber: 0 },
        restrictToFunction: true,
      },
    });
    expect(locations).toEqual([
      { scriptId: "script-7", lineNumber: 10, columnNumber: 4, type: "call" },
      { scriptId: "script-7", lineNumber: 11, columnNumber: 2, type: "return" },
    ]);
  });

  it("rejects invalid and cross-script breakpoint ranges before sending CDP", async () => {
    const { calls, session } = makeSendSession(() => ({ locations: [] }));

    await expect(getPossibleBreakpoints(session, {
      start: { scriptId: "script-7", lineNumber: -1 },
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(getPossibleBreakpoints(session, {
      start: { scriptId: "script-7", lineNumber: 1 },
      end: { scriptId: "script-8", lineNumber: 2 },
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(calls).toHaveLength(0);
  });

  it("binds an exact script location and retains the actual resolved location", async () => {
    const { calls, session } = makeSendSession(() => ({
      breakpointId: "exact-1",
      actualLocation: { scriptId: "script-7", lineNumber: 10, columnNumber: 0 },
    }));

    const handle = await setBreakpointAtLocation(session, {
      location: { scriptId: "script-7", lineNumber: 10, columnNumber: 0 },
      condition: "requestId === 'selected'",
    });

    expect(calls[0]).toEqual({
      method: "Debugger.setBreakpoint",
      params: {
        location: { scriptId: "script-7", lineNumber: 10, columnNumber: 0 },
        condition: "requestId === 'selected'",
      },
    });
    expect(handle).toEqual({
      breakpointId: "exact-1",
      requestedLocation: { scriptId: "script-7", lineNumber: 10, columnNumber: 0 },
      actualLocation: { scriptId: "script-7", lineNumber: 10, columnNumber: 0 },
    });
  });

  it("treats an omitted CDP column as zero when validating an exact binding", async () => {
    const { session } = makeSendSession(() => ({
      breakpointId: "exact-default-column",
      actualLocation: { scriptId: "script-7", lineNumber: 10, columnNumber: 0 },
    }));

    await expect(setBreakpointAtLocation(session, {
      location: { scriptId: "script-7", lineNumber: 10 },
    })).resolves.toMatchObject({
      breakpointId: "exact-default-column",
      requestedLocation: { scriptId: "script-7", lineNumber: 10 },
      actualLocation: { scriptId: "script-7", lineNumber: 10, columnNumber: 0 },
    });
  });

  it("fails closed when exact breakpoint binding is malformed", async () => {
    const { session } = makeSendSession(() => ({ breakpointId: "exact-1" }));

    await expect(setBreakpointAtLocation(session, {
      location: { scriptId: "script-7", lineNumber: 10 },
    })).rejects.toMatchObject({ code: "CDP_REQUEST_FAILED" });
  });

  it("removes an exact breakpoint when CDP binds it to a different script", async () => {
    const { calls, session } = makeSendSession(({ method }) => method === "Debugger.setBreakpoint"
      ? {
          breakpointId: "exact-foreign",
          actualLocation: { scriptId: "script-8", lineNumber: 10, columnNumber: 4 },
        }
      : {});

    await expect(setBreakpointAtLocation(session, {
      location: { scriptId: "script-7", lineNumber: 10 },
    })).rejects.toMatchObject({ code: "INVALID_BREAKPOINT" });
    expect(calls.at(-1)).toEqual({
      method: "Debugger.removeBreakpoint",
      params: { breakpointId: "exact-foreign" },
    });
  });

  it("removes an exact breakpoint when CDP relocates it to another line", async () => {
    const { calls, session } = makeSendSession(({ method }) => method === "Debugger.setBreakpoint"
      ? {
          breakpointId: "exact-relocated",
          actualLocation: { scriptId: "script-7", lineNumber: 11, columnNumber: 0 },
        }
      : {});

    await expect(setBreakpointAtLocation(session, {
      location: { scriptId: "script-7", lineNumber: 10 },
    })).rejects.toMatchObject({ code: "INVALID_BREAKPOINT" });
    expect(calls.at(-1)).toEqual({
      method: "Debugger.removeBreakpoint",
      params: { breakpointId: "exact-relocated" },
    });
  });

  it("removes an exact breakpoint when CDP relocates it on the same line", async () => {
    const { calls, session } = makeSendSession(({ method }) => method === "Debugger.setBreakpoint"
      ? {
          breakpointId: "exact-wrong-column",
          actualLocation: { scriptId: "script-7", lineNumber: 10, columnNumber: 9 },
        }
      : {});

    await expect(setBreakpointAtLocation(session, {
      location: { scriptId: "script-7", lineNumber: 10, columnNumber: 4 },
    })).rejects.toMatchObject({ code: "INVALID_BREAKPOINT" });
    expect(calls.at(-1)).toEqual({
      method: "Debugger.removeBreakpoint",
      params: { breakpointId: "exact-wrong-column" },
    });
  });

  it("sends step commands without speculative parameters by default", async () => {
    const { calls, session } = makeSendSession(() => ({}));

    await stepInto(session);
    await stepInto(session, { breakOnAsyncCall: true });
    await stepOver(session);
    await stepOut(session);

    expect(calls).toEqual([
      { method: "Debugger.stepInto", params: {} },
      { method: "Debugger.stepInto", params: { breakOnAsyncCall: true } },
      { method: "Debugger.stepOver", params: {} },
      { method: "Debugger.stepOut", params: {} },
    ]);
  });

  it("releases individual and grouped remote object handles", async () => {
    const { calls, session } = makeSendSession(() => ({}));

    await releaseObject(session, "object-1");
    await releaseObjectGroup(session, "trace-step-1");

    expect(calls).toEqual([
      { method: "Runtime.releaseObject", params: { objectId: "object-1" } },
      { method: "Runtime.releaseObjectGroup", params: { objectGroup: "trace-step-1" } },
    ]);
  });

  it("assigns frame evaluation results to an explicitly releasable object group", async () => {
    const { calls, session } = makeSendSession(() => ({ result: { type: "object", objectId: "object-1" } }));

    await evaluateOnFrame(session, "frame-1", "payload", { objectGroup: "trace-step-1" });

    expect(calls[0]?.params["objectGroup"]).toBe("trace-step-1");
  });
});

describe("protocol metadata conversion", () => {
  it.each([
    { scriptId: "script-7", lineNumber: -1 },
    { scriptId: "script-7", lineNumber: 1.5 },
    { scriptId: "script-7", lineNumber: 1, columnNumber: -1 },
    { scriptId: "script-7", lineNumber: 1, columnNumber: 0.5 },
  ])("rejects malformed CDP source coordinates %#", (location) => {
    expect(toScriptLocation(location)).toBeUndefined();
  });

  it("preserves loaded script range, identity, hash, and source-map metadata", () => {
    expect(toScriptInfo({
      scriptId: "script-7",
      url: "file:///home/vcap/app/dist/service.js",
      startLine: 0,
      startColumn: 0,
      endLine: 80,
      endColumn: 1,
      executionContextId: 3,
      hash: "sha256-hash",
      buildId: "debug-id",
      sourceMapURL: "service.js.map",
      hasSourceURL: true,
      isModule: true,
      length: 4096,
    })).toEqual({
      scriptId: "script-7",
      url: "file:///home/vcap/app/dist/service.js",
      startLine: 0,
      startColumn: 0,
      endLine: 80,
      endColumn: 1,
      executionContextId: 3,
      hash: "sha256-hash",
      buildId: "debug-id",
      sourceMapURL: "service.js.map",
      hasSourceURL: true,
      isModule: true,
      length: 4096,
    });
  });

  it.each([
    "regexp",
    "date",
    "map",
    "set",
    "weakmap",
    "weakset",
    "iterator",
    "generator",
    "promise",
    "typedarray",
    "arraybuffer",
    "dataview",
    "webassemblymemory",
    "wasmvalue",
    "trustedtype",
  ])(
    "marks %s values as truncated when internal slots are not materialized",
    (subtype) => {
      expect(toRemoteObject({
        type: "object",
        subtype,
        className: subtype,
        description: `${subtype} description`,
        objectId: `${subtype}-1`,
      })).toMatchObject({
        subtype,
        completeness: "truncated",
      });
    },
  );

  it("marks proxy values unavailable without changing ordinary object descriptors", () => {
    expect(toRemoteObject({
      type: "object",
      subtype: "proxy",
      className: "Proxy",
      objectId: "proxy-1",
    })).toMatchObject({ completeness: "unavailable" });
    expect(toRemoteObject({
      type: "object",
      className: "Object",
      description: "Object",
      objectId: "object-1",
    })).toEqual({
      type: "object",
      className: "Object",
      description: "Object",
      objectId: "object-1",
    });
  });

  it("preserves frame, scope, return, this, and async-stack metadata", () => {
    const pause = toPauseEvent({
      reason: "step",
      hitBreakpoints: [],
      callFrames: [{
        callFrameId: "frame-1",
        functionName: "createOrder",
        location: { scriptId: "script-7", lineNumber: 12, columnNumber: 3 },
        functionLocation: { scriptId: "script-7", lineNumber: 8, columnNumber: 0 },
        url: "",
        scopeChain: [{
          type: "local",
          name: "createOrder",
          object: { type: "object", className: "Object", objectId: "scope-1" },
          startLocation: { scriptId: "script-7", lineNumber: 8, columnNumber: 0 },
          endLocation: { scriptId: "script-7", lineNumber: 18, columnNumber: 1 },
        }],
        this: { type: "object", className: "OrderService", objectId: "this-1" },
        returnValue: { type: "number", unserializableValue: "NaN", description: "NaN" },
      }],
      asyncStackTrace: {
        description: "await",
        callFrames: [{
          functionName: "dispatch",
          scriptId: "script-6",
          url: "file:///home/vcap/app/dist/router.js",
          lineNumber: 2,
          columnNumber: 1,
        }],
        parentId: { id: "parent-stack", debuggerId: "debugger-1" },
      },
      asyncStackTraceId: { id: "async-stack", debuggerId: "debugger-1" },
      asyncCallStackTraceId: { id: "async-call", debuggerId: "debugger-1" },
    }, 100, new Map([[
      "script-7",
      { scriptId: "script-7", url: "file:///home/vcap/app/dist/service.js" },
    ]]));

    expect(pause.callFrames[0]).toMatchObject({
      scriptId: "script-7",
      url: "file:///home/vcap/app/dist/service.js",
      functionLocation: { scriptId: "script-7", lineNumber: 8, columnNumber: 0 },
      thisObject: { type: "object", className: "OrderService", objectId: "this-1" },
      returnValue: { type: "number", unserializableValue: "NaN", description: "NaN" },
      scopeChain: [{
        type: "local",
        objectId: "scope-1",
        object: { type: "object", className: "Object", objectId: "scope-1" },
        startLocation: { scriptId: "script-7", lineNumber: 8, columnNumber: 0 },
        endLocation: { scriptId: "script-7", lineNumber: 18, columnNumber: 1 },
      }],
    });
    expect(pause.asyncStackTrace).toMatchObject({
      description: "await",
      callFrames: [{ functionName: "dispatch", scriptId: "script-6", lineNumber: 2 }],
      parentId: { id: "parent-stack", debuggerId: "debugger-1" },
    });
    expect(pause.asyncStackTraceId).toEqual({ id: "async-stack", debuggerId: "debugger-1" });
    expect(pause.asyncCallStackTraceId).toEqual({ id: "async-call", debuggerId: "debugger-1" });
  });
});

function matchingPause(): PauseEvent {
  return { reason: "other", hitBreakpoints: ["bp-1"], callFrames: [] };
}

describe("abortable pause waits", () => {
  it("does not consume a buffered pause when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const buffered = matchingPause();
    const session = makeSendSession(() => ({})).session;
    session.pauseBuffer.push(buffered);

    await expect(waitForPause(session, {
      timeoutMs: 1_000,
      breakpointIds: ["bp-1"],
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "ABORTED" });
    expect(session.pauseBuffer).toEqual([buffered]);
  });

  it("forwards a live abort and always releases the pause wait gate", async () => {
    const controller = new AbortController();
    const waitFor = vi.fn(async (
      _method: string,
      options: { readonly signal?: AbortSignal },
    ): Promise<never> => await new Promise<never>((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => {
        reject(new CfInspectorError("ABORTED", "Operation aborted"));
      }, { once: true });
    }));
    const session = makeSendSession(() => ({})).session;
    Object.assign(session, { client: { waitFor } as unknown as CdpClient });

    const pending = waitForPause(session, { timeoutMs: 1_000, signal: controller.signal });
    expect(session.pauseWaitGate.active).toBe(true);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(waitFor).toHaveBeenCalledWith("Debugger.paused", expect.objectContaining({
      signal: controller.signal,
    }));
    expect(session.pauseWaitGate.active).toBe(false);
  });
});
