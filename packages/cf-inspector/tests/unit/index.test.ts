import { describe, expect, it } from "vitest";

import {
  buildBreakpointUrlRegex,
  buildLogpointCondition,
  captureSnapshot,
  CfInspectorError,
  connectInspector,
  discoverInspectorTargets,
  evaluateGlobal,
  evaluateOnFrame,
  fetchInspectorVersion,
  getProperties,
  listScripts,
  openCfTunnel,
  parseBreakpointSpec,
  parseRemoteRoot,
  removeBreakpoint,
  resume,
  setBreakpoint,
  streamLogpoint,
  validateExpression,
  waitForPause,
} from "../../src/index.js";

describe("public package API", () => {
  it("keeps the documented function exports available", () => {
    expect(buildBreakpointUrlRegex).toEqual(expect.any(Function));
    expect(buildLogpointCondition).toEqual(expect.any(Function));
    expect(captureSnapshot).toEqual(expect.any(Function));
    expect(connectInspector).toEqual(expect.any(Function));
    expect(discoverInspectorTargets).toEqual(expect.any(Function));
    expect(evaluateGlobal).toEqual(expect.any(Function));
    expect(evaluateOnFrame).toEqual(expect.any(Function));
    expect(fetchInspectorVersion).toEqual(expect.any(Function));
    expect(getProperties).toEqual(expect.any(Function));
    expect(listScripts).toEqual(expect.any(Function));
    expect(openCfTunnel).toEqual(expect.any(Function));
    expect(parseBreakpointSpec).toEqual(expect.any(Function));
    expect(parseRemoteRoot).toEqual(expect.any(Function));
    expect(removeBreakpoint).toEqual(expect.any(Function));
    expect(resume).toEqual(expect.any(Function));
    expect(setBreakpoint).toEqual(expect.any(Function));
    expect(streamLogpoint).toEqual(expect.any(Function));
    expect(validateExpression).toEqual(expect.any(Function));
    expect(waitForPause).toEqual(expect.any(Function));
  });

  it("keeps the package error type constructible", () => {
    const err = new CfInspectorError("INVALID_ARGUMENT", "bad input", "details");

    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("INVALID_ARGUMENT");
    expect(err.message).toBe("bad input");
    expect(err.detail).toBe("details");
  });
});
