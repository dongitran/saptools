import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  buildGitCredentialEnv,
  gitHead,
  listPatchEquivalentCommits,
  orderCommitsBySourceHistory,
  runGit,
  validatePortBranches,
} from "../../src/git.js";
import type { SourceCommit } from "../../src/types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd });
}

describe("Git helpers", () => {
  it("builds a credential helper environment without putting the token in Git config", () => {
    const env = buildGitCredentialEnv("super-token");
    const {
      GITPORT_GIT_CREDENTIAL_TOKEN: token,
      GIT_CONFIG_KEY_0: configKey,
      GIT_CONFIG_VALUE_0: configValue,
      GIT_TERMINAL_PROMPT: terminalPrompt,
    } = env;

    expect(token).toBe("super-token");
    expect(configKey).toBe("credential.helper");
    expect(configValue).toContain("GITPORT_GIT_CREDENTIAL_TOKEN");
    expect(configValue).not.toContain("super-token");
    expect(terminalPrompt).toBe("0");
  });

  it("validates branch names and rejects ambiguous port branches", async () => {
    await expect(validatePortBranches("main", "gitport/repo-a-mr-123")).resolves.toBeUndefined();
    await expect(validatePortBranches("main", "main")).rejects.toThrow(/must differ/);
    await expect(validatePortBranches(" main", "gitport/repo-a-mr-123")).rejects.toThrow(
      /Base branch is not a valid branch name/,
    );
    await expect(validatePortBranches("main", "-bad")).rejects.toThrow(
      /Port branch is not a valid branch name/,
    );
    await expect(validatePortBranches("main", "bad branch")).rejects.toThrow(
      /Port branch is not a valid branch name/,
    );
  });

  it("orders GitLab MR commits by fetched source history", async () => {
    const root = await mkdtemp(join(tmpdir(), "gitport-order-"));
    try {
      const repo = join(root, "repo");
      await execFileAsync("git", ["init", "-b", "main", repo]);
      await configureCleanRepo(repo);
      await git(repo, ["checkout", "-b", "source"]);
      await writeFile(join(repo, "feature.txt"), "one\n", "utf8");
      await git(repo, ["add", "feature.txt"]);
      await git(repo, ["commit", "-m", "first"]);
      const firstSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
      await writeFile(join(repo, "feature.txt"), "one\ntwo\n", "utf8");
      await git(repo, ["commit", "-am", "second"]);
      const secondSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
      await git(repo, ["checkout", "main"]);

      const newestFirst: readonly SourceCommit[] = [
        { sha: secondSha, title: "second", message: "second\n" },
        { sha: firstSha, title: "first", message: "first\n" },
      ];
      await expect(
        orderCommitsBySourceHistory(repo, newestFirst, "HEAD", "source"),
      ).resolves.toEqual([
        { sha: firstSha, title: "first", message: "first\n" },
        { sha: secondSha, title: "second", message: "second\n" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps empty commit lists empty when ordering by source history", async () => {
    await expect(orderCommitsBySourceHistory(process.cwd(), [], "HEAD", "HEAD")).resolves.toEqual([]);
  });

  it("rejects GitLab MR commits that are not reachable from the fetched source branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "gitport-order-missing-"));
    try {
      const repo = join(root, "repo");
      await execFileAsync("git", ["init", "-b", "main", repo]);
      await configureCleanRepo(repo);

      await expect(
        orderCommitsBySourceHistory(
          repo,
          [{ sha: "0123456789012345678901234567890123456789", title: "missing", message: "missing" }],
          "HEAD",
          "main",
        ),
      ).rejects.toThrow(/not reachable from the fetched source branch/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads HEAD in a clean repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "gitport-clean-"));
    try {
      const repo = join(root, "repo");
      await execFileAsync("git", ["init", "-b", "main", repo]);
      await configureCleanRepo(repo);
      const head = await gitHead(repo);
      expect(head).toMatch(/^[a-f0-9]{40}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts secrets from Git command errors", async () => {
    await expect(
      runGit(["clone", "https://oauth2:super-token@gitlab.example.com/missing.git"], {
        secrets: ["super-token"],
      }),
    ).rejects.not.toThrow(/super-token/);
  });

  it("detects patch-equivalent commits with git cherry", async () => {
    const root = await mkdtemp(join(tmpdir(), "gitport-cherry-"));
    try {
      const repo = join(root, "repo");
      await execFileAsync("git", ["init", "-b", "main", repo]);
      await configureCleanRepo(repo);
      await git(repo, ["checkout", "-b", "source"]);
      await writeFile(join(repo, "feature.txt"), "same patch\n", "utf8");
      await git(repo, ["add", "feature.txt"]);
      await git(repo, ["commit", "-m", "source patch"]);
      const sourceSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
      await git(repo, ["checkout", "main"]);
      await writeFile(join(repo, "feature.txt"), "same patch\n", "utf8");
      await git(repo, ["add", "feature.txt"]);
      await git(repo, ["commit", "-m", "destination patch"]);

      const duplicates = await listPatchEquivalentCommits(repo, "main", "source");
      expect(duplicates.has(sourceSha)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function configureCleanRepo(repo: string): Promise<void> {
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test User"]);
  await writeFile(join(repo, "app.txt"), "value=base\n", "utf8");
  await git(repo, ["add", "app.txt"]);
  await git(repo, ["commit", "-m", "base"]);
}
