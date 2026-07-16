import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import {
  parseCfAppInstances,
  parseFindOutput,
  parseGrepOutput,
  parseInspectOutput,
  parseLsOutput,
  parseRootsOutput,
  parseViewOutput,
  suggestBreakpoints,
} from "../../src/discovery/parsers.js";

describe("output parsers", () => {
  it("deduplicates, sorts, and ignores system roots", () => {
    const roots = parseRootsOutput("CFX\tROOT\t/b\nCFX\tROOT\t/srv\nCFX\tROOT\t/a\nCFX\tROOT\t/a\n");
    expect(roots).toEqual(["/a", "/b"]);
  });

  it("parses find rows", () => {
    const matches = parseFindOutput(
      "CFX\tFIND\tfile\t/workspace/app/src/connect.js\nCFX\tFIND\tdirectory\t/workspace/app/src\n",
      1,
    );
    expect(matches).toEqual([
      { instance: 1, kind: "file", path: "/workspace/app/src/connect.js" },
      { instance: 1, kind: "directory", path: "/workspace/app/src" },
    ]);
  });

  it("parses one-level directory listing rows", () => {
    const entries = parseLsOutput(
      [
        "CFX\tLS\tdirectory\tsrc\t/workspace/app/src",
        "CFX\tLS\tfile\tpackage.json\t/workspace/app/package.json",
        "CFX\tLS\tsymlink\tcurrent\t/workspace/app/current\t../releases/current",
        "CFX\tLS\tother\tdevice\t/workspace/app/device",
      ].join("\n"),
      2,
    );

    expect(entries).toEqual([
      { instance: 2, kind: "directory", name: "src", path: "/workspace/app/src" },
      { instance: 2, kind: "file", name: "package.json", path: "/workspace/app/package.json" },
      { instance: 2, kind: "symlink", name: "current", path: "/workspace/app/current", target: "../releases/current" },
      { instance: 2, kind: "other", name: "device", path: "/workspace/app/device" },
    ]);
  });

  it("parses grep rows with optional previews", () => {
    const raw = "CFX\tGREP\t/workspace/app/src/connect.js\t12\tneedle-api ok\n";
    expect(parseGrepOutput(raw, 0, false)).toEqual([
      { instance: 0, path: "/workspace/app/src/connect.js", line: 12 },
    ]);
    expect(parseGrepOutput(raw, 0, true)[0]?.preview).toBe("needle-api ok");
    expect(parseGrepOutput("CFX\tGREP\t/workspace/app/src/connect.js\t0\tnope\n", 0, false))
      .toEqual([]);
    expect(parseGrepOutput("CFX\tGREP\t/workspace/app/src/connect.js\t12abc\tnope\n", 0, false))
      .toEqual([]);
  });

  it("does not confuse preview colon-number-colon text with the grep line delimiter", () => {
    const raw = "CFX\tGREP\t/workspace/app/src/connect.js\t12\tvalue:99:still-preview\n";
    expect(parseGrepOutput(raw, 0, true)).toEqual([
      {
        instance: 0,
        path: "/workspace/app/src/connect.js",
        line: 12,
        preview: "value:99:still-preview",
      },
    ]);
  });

  it("does not confuse preview tab-number-tab text with the grep line delimiter", () => {
    const raw = "CFX\tGREP\t/workspace/app/src/connect.js\t12\tvalue\t99\tstill-preview\n";
    expect(parseGrepOutput(raw, 0, true)).toEqual([
      {
        instance: 0,
        path: "/workspace/app/src/connect.js",
        line: 12,
        preview: "value\t99\tstill-preview",
      },
    ]);
  });

  it("keeps legacy grep row compatibility", () => {
    const raw = "CFX\tGREP\t/workspace/app/src/connect.js:12:needle-api ok\n";
    expect(parseGrepOutput(raw, 0, true)[0]?.preview).toBe("needle-api ok");
  });

  it("keeps legacy grep preview colon-number-colon text in the preview", () => {
    const raw = "CFX\tGREP\t/workspace/app/src/connect.js:12:value:99:still-preview\n";
    expect(parseGrepOutput(raw, 0, true)).toEqual([
      {
        instance: 0,
        path: "/workspace/app/src/connect.js",
        line: 12,
        preview: "value:99:still-preview",
      },
    ]);
  });

  it("rejects adversarial legacy grep rows within a bounded time", () => {
    const payload = `a:9:${"a:9:a".repeat(20_000)}\u2028X`;
    const startedAt = performance.now();

    expect(parseGrepOutput(`CFX\tGREP\t${payload}`, 0, true)).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(150);
  });

  it("keeps Windows-style legacy grep paths", () => {
    expect(parseGrepOutput("CFX\tGREP\tC:\\app\\file.js:12:preview", 0, true)).toEqual([
      { instance: 0, path: "C:\\app\\file.js", line: 12, preview: "preview" },
    ]);
  });

  it("parses view line rows", () => {
    expect(parseViewOutput("CFX\tLINE\t0\tbad\nCFX\tLINE\t8\tfirst\nCFX\tLINE\t9\tsecond\n")).toEqual([
      { line: 8, text: "first" },
      { line: 9, text: "second" },
    ]);
  });

  it("parses instance rows and count fallback", () => {
    const table = ["instances: 2/2", "     state", "#0   running   today", "#1   down"].join("\n");
    expect(parseCfAppInstances(table)).toEqual([
      { index: 0, state: "running", since: "today" },
      { index: 1, state: "down" },
    ]);
    expect(parseCfAppInstances("instances: 2/3")).toEqual([
      { index: 0, state: "running" },
      { index: 1, state: "running" },
    ]);
    expect(parseCfAppInstances("instances: 10001/10001")).toEqual([]);
    expect(parseCfAppInstances("instances: 9007199254740993/9007199254740993")).toEqual([]);
    expect(parseCfAppInstances("no instance information")).toEqual([]);
  });

  it("keeps only the since column from detailed instance rows", () => {
    const table = [
      "instances: 1/1",
      "     state     since                  cpu    memory",
      "#0   running   2026-01-01T00:00:00Z   1.7%   282M of 768M",
    ].join("\n");

    expect(parseCfAppInstances(table)).toEqual([
      { index: 0, state: "running", since: "2026-01-01T00:00:00Z" },
    ]);
  });

  it("rejects adversarial instance rows within a bounded time", () => {
    const row = `9 - ${" ".repeat(60_000)}X\u2028Y\u2028Z`;
    const startedAt = performance.now();

    expect(parseCfAppInstances(row)).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(150);
  });

  it("combines inspect output and suggested breakpoints", () => {
    const parsed = parseInspectOutput(
      [
        "CFX\tROOT\t/workspace/app",
        "CFX\tFIND\tfile\t/workspace/app/src/connect.js",
        "CFX\tGREP\t/workspace/app/src/connect.js\t5\tneedle-api",
      ].join("\n"),
      0,
      false,
    );
    expect(parsed.files).toEqual([{ instance: 0, kind: "file", path: "/workspace/app/src/connect.js" }]);
    expect(parsed.suggestedBreakpoints).toEqual([
      {
        instance: 0,
        bp: "/workspace/app/src/connect.js",
        remoteRoot: "/workspace/app",
        line: 5,
        confidence: "high",
        reason: "content match",
      },
    ]);
  });

  it("can omit inspect files and deduplicates exact candidates", () => {
    const parsed = parseInspectOutput([
      "CFX\tROOT\t/workspace/app",
      "CFX\tFIND\tfile\t/workspace/app/src/connect.js",
      "CFX\tFIND\tfile\t/workspace/app/src/connect.js",
      "CFX\tGREP\t/workspace/app/src/connect.js\t5\tneedle-api",
      "CFX\tGREP\t/workspace/app/src/connect.js\t5\tneedle-api",
    ].join("\n"), 0, false, false);
    expect(parsed.files).toBeUndefined();
    expect(parsed.contentMatches).toHaveLength(1);
    expect(parsed.suggestedBreakpoints).toHaveLength(1);
  });

  it("assigns lower confidence for non-JavaScript paths", () => {
    expect(suggestBreakpoints([], [
      { instance: 0, path: "/other/connect.js", line: 1 },
    ])[0]?.remoteRoot).toBe("/");
    expect(suggestBreakpoints(["/workspace/app"], [
      { instance: 0, path: "/workspace/app/src/connect.ts", line: 1 },
      { instance: 0, path: "/workspace/app/README.md", line: 2 },
    ]).map((item) => item.confidence)).toEqual(["medium", "low"]);
  });
});
