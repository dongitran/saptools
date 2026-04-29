import { describe, expect, it } from "vitest";

import { buildDraftMergeRequestDescription, buildReportMarkdown } from "../../src/report.js";

describe("buildDraftMergeRequestDescription", () => {
  it("includes commit summary and auto-resolved conflict excerpts", () => {
    const description = buildDraftMergeRequestDescription({
      sourceRepo: "https://gitlab.example.com/repo-a.git",
      destRepo: "https://gitlab.example.com/repo-b.git",
      sourceMergeRequestIid: 123,
      sourceMergeRequestTitle: "Fix auth",
      baseBranch: "main",
      portBranch: "gitport/repo-a-mr-123",
      runId: "run-1",
      commits: [
        { sha: "abc", title: "fix auth", status: "applied" },
        { sha: "def", title: "align config", status: "incoming-resolved" },
      ],
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

    expect(description).toContain("Draft MR created by Gitport");
    expect(description).toContain("align config");
    expect(description).toContain("src/app.ts");
    expect(description).toContain("const mode = 'old';");
    expect(description).toContain("incoming");
  });

  it("renders clean ports without conflict sections", () => {
    const description = buildDraftMergeRequestDescription({
      sourceRepo: "https://gitlab.example.com/repo-a.git",
      destRepo: "https://gitlab.example.com/repo-b.git",
      sourceMergeRequestIid: 123,
      sourceMergeRequestTitle: "Fix auth",
      baseBranch: "main",
      portBranch: "gitport/repo-a-mr-123",
      runId: "run-1",
      commits: [],
      conflicts: [],
    });

    expect(description).toContain("No commits were ported.");
    expect(description).toContain("No cherry-pick conflicts were detected.");
  });

  it("escapes markdown code fences inside captured excerpts", () => {
    const description = buildDraftMergeRequestDescription({
      sourceRepo: "a",
      destRepo: "b",
      sourceMergeRequestIid: 1,
      sourceMergeRequestTitle: "MR",
      baseBranch: "main",
      portBranch: "p",
      runId: "r",
      commits: [{ sha: "abcdef1234567890", title: "commit", status: "incoming-resolved" }],
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
      sourceRepo: "a",
      destRepo: "b",
      sourceMergeRequestIid: 1,
      sourceMergeRequestTitle: "MR",
      baseBranch: "main",
      portBranch: "p",
      runId: "r",
      commits: [],
      conflicts: [],
    };
    expect(buildReportMarkdown(input)).toBe(buildDraftMergeRequestDescription(input));
  });
});
