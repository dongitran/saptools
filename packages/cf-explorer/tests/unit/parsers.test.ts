import { describe, expect, it } from "vitest";

import {
  parseCfAppInstances,
  parseFindOutput,
  parseGrepOutput,
  parseInspectOutput,
  parseRootsOutput,
  parseViewOutput,
  suggestBreakpoints,
} from "../../src/parsers.js";

describe("output parsers", () => {
  it("deduplicates and sorts roots", () => {
    const roots = parseRootsOutput("CFX\tROOT\t/b\nCFX\tROOT\t/a\nCFX\tROOT\t/a\n");
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

  it("parses grep rows with optional previews", () => {
    const raw = "CFX\tGREP\t/workspace/app/src/connect.js\t12\tneedle-api ok\n";
    expect(parseGrepOutput(raw, 0, false)).toEqual([
      { instance: 0, path: "/workspace/app/src/connect.js", line: 12 },
    ]);
    expect(parseGrepOutput(raw, 0, true)[0]?.preview).toBe("needle-api ok");
    expect(parseGrepOutput("CFX\tGREP\t/workspace/app/src/connect.js\t0\tnope\n", 0, false))
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
    expect(parseCfAppInstances("no instance information")).toEqual([]);
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
