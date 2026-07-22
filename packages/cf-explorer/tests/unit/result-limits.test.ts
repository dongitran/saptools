import { describe, expect, it } from "vitest";

import type { FindMatch, GrepMatch } from "../../src/core/types.js";
import { limitInspectResults, limitResults } from "../../src/discovery/result-limits.js";

describe("discovery result limits", () => {
  it("only marks and trims values when the probe returned more than the user limit", () => {
    const values = ["a", "b", "c"] as const;

    expect(limitResults(values, undefined)).toEqual({ values, capped: false });
    expect(limitResults(values, 3)).toEqual({ values, capped: false });
    expect(limitResults(values, 2)).toEqual({ values: ["a", "b"], capped: true });
  });

  it("trims every inspect collection and rebuilds breakpoints from retained matches", () => {
    const files: readonly FindMatch[] = [
      { instance: 0, kind: "file", path: "/workspace/a/a.js" },
      { instance: 0, kind: "file", path: "/workspace/b/b.ts" },
      { instance: 0, kind: "file", path: "/workspace/c/c.cds" },
    ];
    const contentMatches: readonly GrepMatch[] = [
      { instance: 0, path: "/workspace/a/a.js", line: 1 },
      { instance: 0, path: "/workspace/b/b.ts", line: 2 },
      { instance: 0, path: "/workspace/c/c.cds", line: 3 },
    ];

    const result = limitInspectResults({
      roots: ["/workspace/a", "/workspace/b", "/workspace/c"],
      files,
      contentMatches,
      suggestedBreakpoints: [],
    }, 2, 2);

    expect(result.capped).toBe(true);
    expect(result.value.roots).toEqual(["/workspace/a", "/workspace/b"]);
    expect(result.value.files).toEqual(files.slice(0, 2));
    expect(result.value.contentMatches).toEqual(contentMatches.slice(0, 2));
    expect(result.value.suggestedBreakpoints).toEqual([
      {
        instance: 0,
        bp: "/workspace/a/a.js",
        remoteRoot: "/workspace/a",
        line: 1,
        confidence: "high",
        reason: "content match",
      },
      {
        instance: 0,
        bp: "/workspace/b/b.ts",
        remoteRoot: "/workspace/b",
        line: 2,
        confidence: "medium",
        reason: "content match",
      },
    ]);
  });

  it("keeps exact-limit inspect results complete and preserves omitted file output", () => {
    const contentMatches: readonly GrepMatch[] = [
      { instance: 0, path: "/workspace/a/a.js", line: 1 },
      { instance: 0, path: "/workspace/b/b.js", line: 2 },
    ];

    const result = limitInspectResults({
      roots: ["/workspace/a", "/workspace/b"],
      contentMatches,
      suggestedBreakpoints: [],
    }, 2, 2);

    expect(result.capped).toBe(false);
    expect(result.value).not.toHaveProperty("files");
    expect(result.value.roots).toHaveLength(2);
    expect(result.value.contentMatches).toHaveLength(2);
    expect(result.value.suggestedBreakpoints).toHaveLength(2);
  });

  it("reports a cap when either files or content matches alone overflow", () => {
    const roots = ["/workspace/app"];
    const exactMatches: readonly GrepMatch[] = [
      { instance: 0, path: "/workspace/app/a.js", line: 1 },
      { instance: 0, path: "/workspace/app/b.js", line: 2 },
    ];
    const overflowFiles: readonly FindMatch[] = [
      { instance: 0, kind: "file", path: "/workspace/app/a.js" },
      { instance: 0, kind: "file", path: "/workspace/app/b.js" },
      { instance: 0, kind: "file", path: "/workspace/app/c.js" },
    ];
    const exactFiles = overflowFiles.slice(0, 2);
    const overflowMatches: readonly GrepMatch[] = [
      ...exactMatches,
      { instance: 0, path: "/workspace/app/c.js", line: 3 },
    ];

    expect(limitInspectResults({
      roots,
      files: overflowFiles,
      contentMatches: exactMatches,
      suggestedBreakpoints: [],
    }, 2, 2).capped).toBe(true);
    expect(limitInspectResults({
      roots,
      files: exactFiles,
      contentMatches: overflowMatches,
      suggestedBreakpoints: [],
    }, 2, 2).capped).toBe(true);
  });
});
