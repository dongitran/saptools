import { describe, expect, it } from "vitest";

import { formatRepoTable } from "../../src/git/display.js";
import type { RepoStatus } from "../../src/types.js";

describe("formatRepoTable", () => {
  it("returns no-repos message for empty array", () => {
    const result = formatRepoTable([]);
    expect(result).toContain("No repositories tracked");
  });

  it("contains repo name in output", () => {
    const statuses: RepoStatus[] = [
      {
        name: "my-project",
        path: "/repos/my-project",
        status: {
          branch: "main",
          branchStatus: "in_sync",
          staged: false,
          unstaged: false,
          untracked: false,
          stashed: false,
          ahead: 0,
          behind: 0,
        },
        error: null,
      },
    ];

    const result = formatRepoTable(statuses);
    expect(result).toContain("my-project");
    expect(result).toContain("main");
  });

  it("shows ✓ for in_sync repos", () => {
    const statuses: RepoStatus[] = [
      {
        name: "repo",
        path: "/repos/repo",
        status: {
          branch: "main",
          branchStatus: "in_sync",
          staged: false,
          unstaged: false,
          untracked: false,
          stashed: false,
          ahead: 0,
          behind: 0,
        },
        error: null,
      },
    ];

    const result = formatRepoTable(statuses);
    expect(result).toContain("✓");
  });

  it("shows ahead count for ahead repos", () => {
    const statuses: RepoStatus[] = [
      {
        name: "repo",
        path: "/repos/repo",
        status: {
          branch: "feature",
          branchStatus: "ahead",
          staged: false,
          unstaged: false,
          untracked: false,
          stashed: false,
          ahead: 3,
          behind: 0,
        },
        error: null,
      },
    ];

    const result = formatRepoTable(statuses);
    expect(result).toContain("↑3");
  });

  it("shows behind count for behind repos", () => {
    const statuses: RepoStatus[] = [
      {
        name: "repo",
        path: "/repos/repo",
        status: {
          branch: "main",
          branchStatus: "behind",
          staged: false,
          unstaged: false,
          untracked: false,
          stashed: false,
          ahead: 0,
          behind: 5,
        },
        error: null,
      },
    ];

    const result = formatRepoTable(statuses);
    expect(result).toContain("↓5");
  });

  it("shows diverged counts for diverged repos", () => {
    const statuses: RepoStatus[] = [
      {
        name: "repo",
        path: "/repos/repo",
        status: {
          branch: "main",
          branchStatus: "diverged",
          staged: false,
          unstaged: false,
          untracked: false,
          stashed: false,
          ahead: 2,
          behind: 3,
        },
        error: null,
      },
    ];

    const result = formatRepoTable(statuses);
    expect(result).toContain("⇕2/3");
  });

  it("shows ∅ for repos with no remote", () => {
    const statuses: RepoStatus[] = [
      {
        name: "repo",
        path: "/repos/repo",
        status: {
          branch: "local",
          branchStatus: "no_remote",
          staged: false,
          unstaged: false,
          untracked: false,
          stashed: false,
          ahead: 0,
          behind: 0,
        },
        error: null,
      },
    ];

    const result = formatRepoTable(statuses);
    expect(result).toContain("∅");
  });

  it("shows file flags correctly", () => {
    const statuses: RepoStatus[] = [
      {
        name: "repo",
        path: "/repos/repo",
        status: {
          branch: "main",
          branchStatus: "in_sync",
          staged: true,
          unstaged: true,
          untracked: true,
          stashed: true,
          ahead: 0,
          behind: 0,
        },
        error: null,
      },
    ];

    const result = formatRepoTable(statuses);
    expect(result).toContain("+");
    expect(result).toContain("*");
    expect(result).toContain("?");
    expect(result).toContain("$");
  });

  it("shows error message for failed repos", () => {
    const statuses: RepoStatus[] = [
      {
        name: "broken",
        path: "/repos/broken",
        status: null,
        error: "fatal: not a git repository",
      },
    ];

    const result = formatRepoTable(statuses);
    expect(result).toContain("broken");
    expect(result).toContain("fatal: not a git repository");
  });

  it("renders a header row with column labels", () => {
    const statuses: RepoStatus[] = [
      {
        name: "repo",
        path: "/repos/repo",
        status: {
          branch: "main",
          branchStatus: "in_sync",
          staged: false,
          unstaged: false,
          untracked: false,
          stashed: false,
          ahead: 0,
          behind: 0,
        },
        error: null,
      },
    ];

    const result = formatRepoTable(statuses);
    expect(result).toContain("name");
    expect(result).toContain("branch");
    expect(result).toContain("sync");
    expect(result).toContain("flags");
  });

  it("pads columns to align multiple repos", () => {
    const statuses: RepoStatus[] = [
      {
        name: "short",
        path: "/repos/short",
        status: {
          branch: "main",
          branchStatus: "in_sync",
          staged: false,
          unstaged: false,
          untracked: false,
          stashed: false,
          ahead: 0,
          behind: 0,
        },
        error: null,
      },
      {
        name: "a-very-long-repo-name",
        path: "/repos/a-very-long-repo-name",
        status: {
          branch: "feat/something",
          branchStatus: "ahead",
          staged: false,
          unstaged: false,
          untracked: false,
          stashed: false,
          ahead: 1,
          behind: 0,
        },
        error: null,
      },
    ];

    const result = formatRepoTable(statuses);
    expect(result).toContain("short");
    expect(result).toContain("a-very-long-repo-name");
  });
});
