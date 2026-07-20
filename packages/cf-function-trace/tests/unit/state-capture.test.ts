import { describe, expect, it, vi } from "vitest";

import type { RemotePropertyDescriptor } from "../../src/remote-object.js";
import { capturePausedState } from "../../src/state-capture.js";

describe("paused state capture", () => {
  it("captures local and block scopes plus this for bounded app-owned frames", async () => {
    const releaseObject = vi.fn(async (): Promise<void> => undefined);
    const state = await capturePausedState({
      frames: [
        {
          functionName: "create",
          scriptId: "1",
          url: "file:///home/vcap/app/dist/order.js",
          lineNumber: 4,
          columnNumber: 2,
          thisValue: { type: "object", objectId: "this" },
          scopeChain: [
            { type: "local", objectId: "local" },
            { type: "closure", objectId: "closure" },
          ],
        },
        {
          functionName: "library",
          scriptId: "2",
          url: "file:///home/vcap/app/node_modules/pkg/index.js",
          lineNumber: 1,
          columnNumber: 0,
          scopeChain: [],
        },
      ],
      appRoots: ["/home/vcap/app"],
      maxFrames: 3,
      graphLimits: { maxDepth: 2, maxProperties: 10, maxNodes: 20, maxBytes: 10_000 },
    }, {
      getProperties: async (objectId: string) => objectId === "local"
        ? [{ name: "orderId", value: { type: "string", value: "42" } }]
        : [],
      releaseObject,
    });

    expect(state.frames).toHaveLength(1);
    expect(state.frames[0]?.roots["scope.0.local.orderId"]).toBe("42");
    expect(state.frames[0]?.roots).toHaveProperty("this");
    expect(state.frames[0]?.roots["closure"]).toBeUndefined();
    expect(releaseObject).toHaveBeenCalledWith("local");
  });

  it("captures block and return values while skipping accessors", async () => {
    const state = await capturePausedState({
      frames: [{
        functionName: "finish",
        scriptId: "1",
        url: "file:///home/vcap/app/dist/order.js",
        lineNumber: 9,
        columnNumber: 0,
        returnValue: { type: "string", value: "done" },
        scopeChain: [
          { type: "block", objectId: "block" },
          { type: "catch", objectId: "catch" },
          { type: "local" },
        ],
      }],
      appRoots: ["/home/vcap/app"],
      maxFrames: 1,
      graphLimits: { maxDepth: 2, maxProperties: 10, maxNodes: 10, maxBytes: 1000 },
    }, {
      getProperties: async (): Promise<readonly RemotePropertyDescriptor[]> => [
        { name: "status", value: { type: "string", value: "ready" } },
        { name: "computed", get: { type: "function", objectId: "getter" } },
      ],
      releaseObject: async (): Promise<void> => undefined,
    });

    expect(state.frames[0]?.roots).toEqual({
      "scope.0.block.status": "ready",
      "scope.1.catch.status": "ready",
      return: "done",
    });
    expect(state.completeness).toBe("complete");
  });

  it("propagates graph truncation to the paused-state envelope", async () => {
    const state = await capturePausedState({
      frames: [{
        functionName: "large",
        scriptId: "1",
        url: "file:///home/vcap/app/dist/order.js",
        lineNumber: 1,
        columnNumber: 0,
        thisValue: { type: "object", objectId: "this" },
        scopeChain: [],
      }],
      appRoots: ["/home/vcap/app"],
      maxFrames: 1,
      graphLimits: { maxDepth: 0, maxProperties: 1, maxNodes: 1, maxBytes: 1_000 },
    }, {
      getProperties: async (): Promise<readonly []> => [],
      releaseObject: async (): Promise<void> => undefined,
    });

    expect(state.completeness).toBe("truncated");
    expect(state.frames[0]?.completeness).toBe("truncated");
  });

  it("releases a scope object even when descriptor collection fails", async () => {
    const releaseObject = vi.fn(async (): Promise<void> => undefined);

    await expect(capturePausedState({
      frames: [{
        functionName: "broken",
        scriptId: "1",
        url: "file:///home/vcap/app/dist/order.js",
        lineNumber: 1,
        columnNumber: 0,
        scopeChain: [{ type: "local", objectId: "local" }],
      }],
      appRoots: ["/home/vcap/app"],
      maxFrames: 1,
      graphLimits: { maxDepth: 1, maxProperties: 1, maxNodes: 1, maxBytes: 128 },
    }, {
      getProperties: async (): Promise<readonly []> => {
        throw new Error("scope failure");
      },
      releaseObject,
    })).rejects.toThrow("scope failure");
    expect(releaseObject).toHaveBeenCalledWith("local");
  });

  it("preserves shadowed variables with stable scope identities", async () => {
    const state = await capturePausedState({
      frames: [{
        functionName: "shadowed",
        scriptId: "1",
        url: "file:///home/vcap/app/dist/order.js",
        lineNumber: 5,
        columnNumber: 0,
        scopeChain: [
          { type: "block", objectId: "outer" },
          { type: "block", objectId: "inner" },
        ],
      }],
      appRoots: ["/home/vcap/app"],
      maxFrames: 1,
      graphLimits: { maxDepth: 1, maxProperties: 10, maxNodes: 2, maxBytes: 2_000 },
    }, {
      getProperties: async (objectId: string): Promise<readonly RemotePropertyDescriptor[]> => [{
        name: "status",
        value: { type: "string", value: objectId },
      }],
      releaseObject: async (): Promise<void> => undefined,
    });

    expect(state.frames[0]?.roots).toMatchObject({
      "scope.0.block.status": "outer",
      "scope.1.block.status": "inner",
    });
  });

  it("caps scope roots and the final serialized state within one pause budget", async () => {
    const state = await capturePausedState({
      frames: [0, 1, 2].map((index) => ({
        functionName: `frame${index.toString()}`,
        scriptId: index.toString(),
        url: `file:///home/vcap/app/dist/frame-${index.toString()}.js`,
        lineNumber: index,
        columnNumber: 0,
        scopeChain: [{ type: "local", objectId: `scope-${index.toString()}` }],
      })),
      appRoots: ["/home/vcap/app"],
      maxFrames: 3,
      graphLimits: { maxDepth: 1, maxProperties: 2, maxNodes: 2, maxBytes: 1_024 },
    }, {
      getProperties: async (): Promise<readonly RemotePropertyDescriptor[]> => [
        { name: "a", value: { type: "string", value: "x".repeat(300) } },
        { name: "b", value: { type: "string", value: "y".repeat(300) } },
        { name: "c", value: { type: "string", value: "z".repeat(300) } },
      ],
      releaseObject: async (): Promise<void> => undefined,
    });

    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThanOrEqual(1_024);
    expect(state.completeness).toBe("truncated");
    for (const frame of state.frames) {
      expect(Object.keys(frame.roots).length).toBeLessThanOrEqual(2);
    }
  });
});
