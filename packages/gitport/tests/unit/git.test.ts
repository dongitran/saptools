import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  autoResolveIncomingConflict,
  gitHead,
  listPatchEquivalentCommits,
  listUnmergedFiles,
  runGit,
} from "../../src/git.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd });
}

describe("Git conflict helpers", () => {
  it("captures destination-side code and resolves with incoming", async () => {
    const root = await mkdtemp(join(tmpdir(), "gitport-conflict-"));
    try {
      const repo = join(root, "repo");
      await execFileAsync("git", ["init", "-b", "main", repo]);
      await git(repo, ["config", "user.email", "test@example.com"]);
      await git(repo, ["config", "user.name", "Test User"]);
      await writeFile(join(repo, "app.txt"), "value=base\n", "utf8");
      await git(repo, ["add", "app.txt"]);
      await git(repo, ["commit", "-m", "base"]);
      await git(repo, ["checkout", "-b", "source"]);
      await writeFile(join(repo, "app.txt"), "value=incoming\n", "utf8");
      await git(repo, ["commit", "-am", "incoming"]);
      const incomingSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
      await git(repo, ["checkout", "main"]);
      await writeFile(join(repo, "app.txt"), "value=old-destination\n", "utf8");
      await git(repo, ["commit", "-am", "destination"]);

      await expect(runGit(["cherry-pick", incomingSha], { cwd: repo })).rejects.toThrow();
      const conflict = await autoResolveIncomingConflict(repo, {
        commitSha: incomingSha,
        commitTitle: "incoming",
        secrets: [],
      });

      expect(conflict.files[0]?.oursExcerpt).toContain("old-destination");
      expect(conflict.files[0]?.theirsExcerpt).toContain("incoming");
      expect(await readFile(join(repo, "app.txt"), "utf8")).toBe("value=incoming\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads HEAD and lists no unmerged files in a clean repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "gitport-clean-"));
    try {
      const repo = join(root, "repo");
      await execFileAsync("git", ["init", "-b", "main", repo]);
      await configureCleanRepo(repo);
      const head = await gitHead(repo);
      expect(head).toMatch(/^[a-f0-9]{40}$/);
      await expect(listUnmergedFiles(repo)).resolves.toEqual([]);
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
