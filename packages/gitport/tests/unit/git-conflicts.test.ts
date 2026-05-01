import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  autoResolveIncomingConflict,
  captureConflict,
  isEmptyCherryPickMessage,
  listUnmergedFiles,
} from "../../src/git-conflicts.js";
import { runGit } from "../../src/git.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd });
}

async function configureCleanRepo(repo: string): Promise<void> {
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test User"]);
  await writeFile(join(repo, "app.txt"), "value=base\n", "utf8");
  await git(repo, ["add", "app.txt"]);
  await git(repo, ["commit", "-m", "base"]);
}

async function initCleanRepo(rootPrefix: string): Promise<{ readonly root: string; readonly repo: string }> {
  const root = await mkdtemp(join(tmpdir(), rootPrefix));
  const repo = join(root, "repo");
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await configureCleanRepo(repo);
  return { root, repo };
}

function numberedLines(prefix: string, count: number): string {
  return `${Array.from({ length: count }, (_entry, index) => `${prefix}-${index.toString().padStart(3, "0")}`).join("\n")}\n`;
}

describe("Git conflict helpers", () => {
  it("classifies only empty cherry-pick messages as skippable", () => {
    expect(isEmptyCherryPickMessage("The previous cherry-pick is now empty")).toBe(true);
    expect(isEmptyCherryPickMessage("nothing to commit, working tree clean")).toBe(true);
    expect(isEmptyCherryPickMessage("commit abc is a merge but no -m option was given")).toBe(false);
  });

  it("rejects incoming conflict resolution when the repo has no unmerged files", async () => {
    const { root, repo } = await initCleanRepo("gitport-no-conflict-");
    try {
      await expect(listUnmergedFiles(repo)).resolves.toEqual([]);
      await expect(
        autoResolveIncomingConflict(repo, {
          commitSha: "abc",
          commitTitle: "no conflict",
          secrets: [],
        }),
      ).rejects.toThrow(/no unmerged files/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures destination-side code and resolves with incoming", async () => {
    const { root, repo } = await initCleanRepo("gitport-conflict-");
    try {
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
      await expect(readFile(join(repo, "app.txt"), "utf8")).resolves.toBe("value=incoming\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves incoming delete conflicts by removing the destination file", async () => {
    const { root, repo } = await initCleanRepo("gitport-delete-conflict-");
    try {
      await git(repo, ["checkout", "-b", "source"]);
      await git(repo, ["rm", "app.txt"]);
      await git(repo, ["commit", "-m", "delete incoming"]);
      const incomingSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
      await git(repo, ["checkout", "main"]);
      await writeFile(join(repo, "app.txt"), "value=old-destination\n", "utf8");
      await git(repo, ["commit", "-am", "destination customization"]);

      await expect(runGit(["cherry-pick", incomingSha], { cwd: repo })).rejects.toThrow();
      const conflict = await autoResolveIncomingConflict(repo, {
        commitSha: incomingSha,
        commitTitle: "delete incoming",
        secrets: [],
      });

      expect(conflict.files[0]?.oursExcerpt).toContain("old-destination");
      expect(conflict.files[0]?.theirsExcerpt).toBe("(missing)");
      await expect(readFile(join(repo, "app.txt"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("limits captured conflict excerpts to a bounded size", async () => {
    const { root, repo } = await initCleanRepo("gitport-conflict-excerpt-");
    try {
      await git(repo, ["checkout", "-b", "source"]);
      await writeFile(join(repo, "app.txt"), numberedLines("incoming", 100), "utf8");
      await git(repo, ["commit", "-am", "long incoming"]);
      const incomingSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
      await git(repo, ["checkout", "main"]);
      await writeFile(join(repo, "app.txt"), numberedLines("destination", 100), "utf8");
      await git(repo, ["commit", "-am", "long destination"]);

      await expect(runGit(["cherry-pick", incomingSha], { cwd: repo })).rejects.toThrow();
      const conflict = await captureConflict(repo, {
        commitSha: incomingSha,
        commitTitle: "long incoming",
      });

      expect(conflict.files[0]?.oursExcerpt).toContain("destination-079");
      expect(conflict.files[0]?.oursExcerpt).not.toContain("destination-080");
      expect(conflict.files[0]?.oursExcerpt).toContain("... [truncated]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
