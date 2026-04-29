import { describe, expect, it } from "vitest";

import { buildDraftMergeRequestDescription, buildReportMarkdown } from "../../src/report.js";

describe("buildDraftMergeRequestDescription", () => {
  it("includes commit summary and auto-resolved conflict excerpts", () => {
    const description = buildDraftMergeRequestDescription({
      sourceMergeRequestIid: 123,
      sourceMergeRequestTitle: "Fix auth",
      sourceMergeRequestUrl: "https://gitlab.example.com/repo-a/-/merge_requests/123",
      conflicts: [
        {
          commitSha: "def",
          commitTitle: "align config",
          files: [
            {
              path: "src/app.ts",
              oursExcerpt: "const mode = 'old';",
              theirsExcerpt: "const mode = 'incoming';",
            },
          ],
        },
      ],
    });

    expect(description).toContain(
      "- Source MR: !123 Fix auth ([MR Link](https://gitlab.example.com/repo-a/-/merge_requests/123))",
    );
    expect(description).toContain("align config");
    expect(description).toContain("src/app.ts");
    expect(description).toContain("const mode = 'old';");
    expect(description).toContain("incoming");
    expect(description).not.toContain("Draft MR created by Gitport");
    expect(description).not.toContain("Source repo");
    expect(description).not.toContain("Destination repo");
    expect(description).not.toContain("Base branch");
    expect(description).not.toContain("Port branch");
    expect(description).not.toContain("Run ID");
    expect(description).not.toContain("Strategy");
    expect(description).not.toContain("Ported commits");
    expect(description).not.toContain("Review this Draft MR before marking it ready");
  });

  it("renders clean ports without conflict sections", () => {
    const description = buildDraftMergeRequestDescription({
      sourceMergeRequestIid: 123,
      sourceMergeRequestTitle: "Fix auth",
      sourceMergeRequestUrl: "https://gitlab.example.com/repo-a/-/merge_requests/123",
      conflicts: [],
    });

    expect(description).toContain("No cherry-pick conflicts were detected.");
    expect(description).not.toContain("No commits were ported.");
  });

  it("escapes markdown code fences inside captured excerpts", () => {
    const description = buildDraftMergeRequestDescription({
      sourceMergeRequestIid: 1,
      sourceMergeRequestTitle: "MR",
      sourceMergeRequestUrl: "https://gitlab.example.com/a/-/merge_requests/1",
      conflicts: [
        {
          commitSha: "abcdef1234567890",
          commitTitle: "commit",
          files: [{ path: "a.md", oursExcerpt: "```secret```", theirsExcerpt: "incoming" }],
        },
      ],
    });

    expect(description).toContain("` ` `secret` ` `");
  });

  it("uses the Draft MR description as the local markdown report", () => {
    const input = {
      sourceMergeRequestIid: 1,
      sourceMergeRequestTitle: "MR",
      sourceMergeRequestUrl: "https://gitlab.example.com/a/-/merge_requests/1",
      conflicts: [],
    };
    expect(buildReportMarkdown(input)).toBe(buildDraftMergeRequestDescription(input));
  });
});
