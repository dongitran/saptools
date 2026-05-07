import { describe, expect, it } from "vitest";

import { parseGitStatusPorcelain } from "../../src/git/status.js";

describe("parseGitStatusPorcelain", () => {
  it("parses clean in-sync branch", () => {
    const output = [
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +0 -0",
    ].join("\n");

    const result = parseGitStatusPorcelain(output);

    expect(result.branch).toBe("main");
    expect(result.branchStatus).toBe("in_sync");
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(0);
    expect(result.staged).toBe(false);
    expect(result.unstaged).toBe(false);
    expect(result.untracked).toBe(false);
  });

  it("detects ahead status", () => {
    const output = [
      "# branch.oid abc123",
      "# branch.head feature/x",
      "# branch.upstream origin/feature/x",
      "# branch.ab +3 -0",
    ].join("\n");

    const result = parseGitStatusPorcelain(output);

    expect(result.branchStatus).toBe("ahead");
    expect(result.ahead).toBe(3);
    expect(result.behind).toBe(0);
  });

  it("detects behind status", () => {
    const output = [
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +0 -5",
    ].join("\n");

    const result = parseGitStatusPorcelain(output);

    expect(result.branchStatus).toBe("behind");
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(5);
  });

  it("detects diverged status", () => {
    const output = [
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -3",
    ].join("\n");

    const result = parseGitStatusPorcelain(output);

    expect(result.branchStatus).toBe("diverged");
    expect(result.ahead).toBe(2);
    expect(result.behind).toBe(3);
  });

  it("detects no_remote when no upstream line", () => {
    const output = [
      "# branch.oid abc123",
      "# branch.head local-only",
    ].join("\n");

    const result = parseGitStatusPorcelain(output);

    expect(result.branchStatus).toBe("no_remote");
    expect(result.branch).toBe("local-only");
  });

  it("detects staged changes", () => {
    const output = [
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +0 -0",
      "1 M. N... 100644 100644 100644 abc def file.ts",
    ].join("\n");

    const result = parseGitStatusPorcelain(output);

    expect(result.staged).toBe(true);
    expect(result.unstaged).toBe(false);
  });

  it("detects unstaged changes", () => {
    const output = [
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +0 -0",
      "1 .M N... 100644 100644 100644 abc def file.ts",
    ].join("\n");

    const result = parseGitStatusPorcelain(output);

    expect(result.staged).toBe(false);
    expect(result.unstaged).toBe(true);
  });

  it("detects both staged and unstaged changes", () => {
    const output = [
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +0 -0",
      "1 MM N... 100644 100644 100644 abc def file.ts",
    ].join("\n");

    const result = parseGitStatusPorcelain(output);

    expect(result.staged).toBe(true);
    expect(result.unstaged).toBe(true);
  });

  it("detects untracked files", () => {
    const output = [
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +0 -0",
      "? new-file.ts",
    ].join("\n");

    const result = parseGitStatusPorcelain(output);

    expect(result.untracked).toBe(true);
    expect(result.staged).toBe(false);
    expect(result.unstaged).toBe(false);
  });

  it("handles detached HEAD", () => {
    const output = [
      "# branch.oid abc123",
      "# branch.head (detached)",
    ].join("\n");

    const result = parseGitStatusPorcelain(output);

    expect(result.branch).toBe("(detached)");
    expect(result.branchStatus).toBe("no_remote");
  });

  it("handles empty output gracefully", () => {
    const result = parseGitStatusPorcelain("");

    expect(result.branch).toBe("HEAD");
    expect(result.branchStatus).toBe("no_remote");
    expect(result.staged).toBe(false);
    expect(result.unstaged).toBe(false);
    expect(result.untracked).toBe(false);
  });
});
