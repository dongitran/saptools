import { describe, expect, it } from "vitest";

import { CfExplorerError } from "../../src/errors.js";
import {
  createCommandId,
  parseProtocolFrame,
  requireSuccessfulFrame,
  wrapRemoteScript,
} from "../../src/protocol.js";

describe("persistent session protocol", () => {
  it("wraps scripts with unique sentinel markers", () => {
    expect(createCommandId(() => "abc-123")).toBe("abc123");
    const wrapped = wrapRemoteScript("printf ok", "abc123");
    expect(wrapped.startMarker).toBe("__CF_EXPLORER_START_abc123__");
    expect(wrapped.script).toContain("__CF_EXPLORER_END_abc123__");
  });

  it("returns undefined for partial frames", () => {
    const wrapped = wrapRemoteScript("printf ok", "abc123");
    expect(parseProtocolFrame("before start", wrapped)).toBeUndefined();
    expect(parseProtocolFrame(`${wrapped.startMarker}\npartial`, wrapped)).toBeUndefined();
  });

  it("parses complete frames", () => {
    const wrapped = wrapRemoteScript("printf ok", "abc123");
    const frame = parseProtocolFrame(
      `${wrapped.startMarker}\nhello\n${wrapped.endMarkerPrefix}:0\n`,
      wrapped,
    );
    expect(frame).toEqual({ commandId: "abc123", stdout: "hello\n", exitCode: 0 });
    expect(requireSuccessfulFrame({ commandId: "abc123", stdout: "ok", exitCode: 0 })).toBe("ok");
  });

  it("throws for unsuccessful frames", () => {
    expect(() => requireSuccessfulFrame({ commandId: "a", stdout: "", exitCode: 2 }))
      .toThrow(CfExplorerError);
  });

  it("throws for malformed end markers", () => {
    const wrapped = wrapRemoteScript("printf ok", "abc123");
    expect(() => parseProtocolFrame(
      `${wrapped.startMarker}\nhello\n${wrapped.endMarkerPrefix}:nope\n`,
      wrapped,
    )).toThrow(CfExplorerError);
  });
});
