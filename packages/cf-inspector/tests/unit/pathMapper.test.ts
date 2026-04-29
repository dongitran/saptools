import { describe, expect, it } from "vitest";

import {
  buildBreakpointUrlRegex,
  parseBreakpointSpec,
  parseRemoteRoot,
} from "../../src/pathMapper.js";
import { CfInspectorError } from "../../src/types.js";

describe("parseBreakpointSpec", () => {
  it("parses file:line", () => {
    expect(parseBreakpointSpec("src/handler.ts:42")).toEqual({
      file: "src/handler.ts",
      line: 42,
    });
  });

  it("supports absolute paths and last colon split", () => {
    expect(parseBreakpointSpec("/usr/srv/handler.ts:1")).toEqual({
      file: "/usr/srv/handler.ts",
      line: 1,
    });
  });

  it("rejects missing colon", () => {
    expect(() => parseBreakpointSpec("file.ts")).toThrowError(CfInspectorError);
  });

  it("rejects non-positive line numbers", () => {
    expect(() => parseBreakpointSpec("file.ts:0")).toThrowError(CfInspectorError);
    expect(() => parseBreakpointSpec("file.ts:-3")).toThrowError(CfInspectorError);
  });

  it("rejects non-integer lines", () => {
    expect(() => parseBreakpointSpec("file.ts:1.5")).toThrowError(CfInspectorError);
    expect(() => parseBreakpointSpec("file.ts:abc")).toThrowError(CfInspectorError);
  });

  it("rejects empty file path", () => {
    expect(() => parseBreakpointSpec(":42")).toThrowError(CfInspectorError);
  });
});

describe("parseRemoteRoot", () => {
  it("returns none when undefined or empty", () => {
    expect(parseRemoteRoot(undefined)).toEqual({ kind: "none" });
    expect(parseRemoteRoot("   ")).toEqual({ kind: "none" });
  });

  it("returns literal for plain paths and strips trailing slash", () => {
    expect(parseRemoteRoot("/home/vcap/app")).toEqual({
      kind: "literal",
      value: "/home/vcap/app",
    });
    expect(parseRemoteRoot("/home/vcap/app/")).toEqual({
      kind: "literal",
      value: "/home/vcap/app",
    });
  });

  it("parses regex: prefix", () => {
    const result = parseRemoteRoot("regex:^/example-root-.*$");
    expect(result.kind).toBe("regex");
    if (result.kind === "regex") {
      expect(result.pattern).toBe("^/example-root-.*$");
      expect(result.flags).toBe("");
      expect(result.regex.test("/example-root-foo")).toBe(true);
    }
  });

  it("parses /pattern/flags slash-delimited form", () => {
    const result = parseRemoteRoot("/^\\/example-root-[a-z]+$/i");
    expect(result.kind).toBe("regex");
    if (result.kind === "regex") {
      expect(result.flags).toBe("i");
      expect(result.regex.test("/EXAMPLE-ROOT-FOO")).toBe(true);
    }
  });

  it("throws CfInspectorError on invalid regex", () => {
    expect(() => parseRemoteRoot("regex:[")).toThrowError(CfInspectorError);
  });

  it("treats a slash-delimited form without flags as a literal path", () => {
    expect(parseRemoteRoot("/home/vcap/app/")).toEqual({
      kind: "literal",
      value: "/home/vcap/app",
    });
  });

  it("respects escaped slashes when finding the closing slash", () => {
    const result = parseRemoteRoot("/foo\\/bar/i");
    expect(result.kind).toBe("regex");
    if (result.kind === "regex") {
      expect(result.pattern).toBe("foo\\/bar");
    }
  });

  it("returns literal for single-character paths and preserves trailing slash absence", () => {
    expect(parseRemoteRoot("/")).toEqual({ kind: "literal", value: "/" });
  });
});

describe("buildBreakpointUrlRegex", () => {
  it("falls back to (?:^|/) anchored urlRegex when no remote-root is given", () => {
    const regex = buildBreakpointUrlRegex({
      file: "src/handler.ts",
      remoteRoot: { kind: "none" },
    });
    const r = new RegExp(regex);
    expect(r.test("file:///home/vcap/app/src/handler.ts")).toBe(true);
    expect(r.test("file:///home/vcap/app/src/handler.js")).toBe(true);
    expect(r.test("file:///home/vcap/app/other/src/handler.ts")).toBe(true);
    expect(r.test("file:///home/vcap/app/src/other.ts")).toBe(false);
  });

  it("anchors the urlRegex against a literal remote-root", () => {
    const regex = buildBreakpointUrlRegex({
      file: "src/handler.ts",
      remoteRoot: { kind: "literal", value: "/home/vcap/app" },
    });
    const r = new RegExp(regex);
    expect(r.test("file:///home/vcap/app/src/handler.ts")).toBe(true);
    expect(r.test("file:///home/vcap/app/src/handler.js")).toBe(true);
    expect(r.test("file:///example-root-foo/src/handler.ts")).toBe(false);
  });

  it("interpolates a regex remote-root", () => {
    const setting = parseRemoteRoot("regex:/example-root-[a-z]+");
    const regex = buildBreakpointUrlRegex({
      file: "src/handler.ts",
      remoteRoot: setting,
    });
    const r = new RegExp(regex);
    expect(r.test("file:///example-root-alpha/src/handler.ts")).toBe(true);
    expect(r.test("file:///example-root-beta/src/handler.js")).toBe(true);
    expect(r.test("file:///other/src/handler.ts")).toBe(false);
  });

  it("strips ./ leading and accepts files without .ts/.js extension", () => {
    const regex = buildBreakpointUrlRegex({
      file: "./src/server",
      remoteRoot: { kind: "none" },
    });
    const r = new RegExp(regex);
    expect(r.test("file:///app/src/server.js")).toBe(true);
    expect(r.test("file:///app/src/server")).toBe(true);
  });

  it("escapes special regex characters in the file part", () => {
    const regex = buildBreakpointUrlRegex({
      file: "src/[id].ts",
      remoteRoot: { kind: "none" },
    });
    const r = new RegExp(regex);
    expect(r.test("file:///app/src/[id].ts")).toBe(true);
    expect(r.test("file:///app/src/Aid.ts")).toBe(false);
  });
});
