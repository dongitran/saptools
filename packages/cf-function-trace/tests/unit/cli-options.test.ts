import { describe, expect, it } from "vitest";

import { resolveRecordOptions } from "../../src/cli/options.js";

describe("trace CLI options", () => {
  it("resolves a strict local target and bounded trace limits", () => {
    const options = resolveRecordOptions({
      port: "9229",
      host: "127.0.0.1",
      callDepth: "0",
      timeout: "60",
      maxSteps: "200",
      maxPausedMs: "5000",
      checkpointEvery: "25",
      maxObjectDepth: "4",
      maxProperties: "100",
      maxNodes: "1000",
      maxStateBytes: "2000000",
      appRoot: "/srv/app",
      confirmImpact: false,
    });
    expect(options.target).toEqual({ kind: "local", host: "127.0.0.1", port: 9229 });
    expect(options.limits).toEqual({
      callDepth: 0,
      timeoutMs: 60_000,
      maxSteps: 200,
      maxPausedMs: 5_000,
      checkpointEvery: 25,
      maxObjectDepth: 4,
      maxProperties: 100,
      maxNodes: 1_000,
      maxStateBytes: 2_000_000,
      asyncStackDepth: 4,
    });
    expect(options.appRoot).toBe("/srv/app");
    expect(options.matchCondition).toBeUndefined();
  });

  it("resolves the match predicate and async stack depth, and rejects malformed values", () => {
    const options = resolveRecordOptions({
      port: "9229",
      match: '  req.data.id === "42"  ',
      asyncStackDepth: "8",
      confirmImpact: false,
    });
    expect(options.matchCondition).toBe('req.data.id === "42"');
    expect(options.limits.asyncStackDepth).toBe(8);

    expect(resolveRecordOptions({ port: "9229", match: "   ", confirmImpact: false }).matchCondition).toBeUndefined();
    expect(() => resolveRecordOptions({ port: "9229", match: `req${String.fromCharCode(0)}x`, confirmImpact: false }))
      .toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => resolveRecordOptions({ port: "9229", asyncStackDepth: "-1", confirmImpact: false }))
      .toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("resolves an explicitly confirmed Cloud Foundry target", () => {
    const options = resolveRecordOptions({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "orders",
      process: "worker",
      instance: "2",
      nodePid: "4312",
      tunnelPort: "24321",
      callDepth: "1",
      timeout: "30",
      maxSteps: "50",
      maxPausedMs: "2000",
      checkpointEvery: "10",
      confirmImpact: true,
    });
    expect(options.target).toMatchObject({
      kind: "cf",
      process: "worker",
      instance: 2,
      nodePid: 4312,
      preferredPort: 24_321,
      confirmImpact: true,
    });
  });

  it("rejects mixed targets, incomplete CF selectors, and malformed integers", () => {
    const limits = {
      callDepth: "0",
      timeout: "60",
      maxSteps: "200",
      maxPausedMs: "5000",
      checkpointEvery: "25",
      confirmImpact: false,
    } as const;
    expect(() => resolveRecordOptions({ ...limits, port: "9229", app: "orders" })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => resolveRecordOptions({ ...limits, region: "eu10", app: "orders" })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => resolveRecordOptions({ ...limits, port: "9229", callDepth: "3" })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => resolveRecordOptions({ ...limits, port: "9229", maxSteps: "2x" })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => resolveRecordOptions({ ...limits, port: "9229", appRoot: "relative/app" })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => resolveRecordOptions({ ...limits, port: "9229", maxNodes: "0" })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => resolveRecordOptions({ ...limits, port: "9229", host: "10.0.0.8" })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => resolveRecordOptions({ ...limits, region: "eu10", org: "org", space: "dev", app: "orders", tunnelPort: "70000" })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });
});
