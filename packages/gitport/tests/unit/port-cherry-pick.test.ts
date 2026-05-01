import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { cherryPickCommits } from "../../src/port-cherry-pick.js";
import type { SourceCommit } from "../../src/types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return stdout;
}

async function gitNoCwd(args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args]);
}

async function configureCleanRepo(repo: string): Promise<void> {
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test User"]);
  await writeFile(join(repo, "app.txt"), "value=base\n", "utf8");
  await git(repo, ["add", "app.txt"]);
  await git(repo, ["commit", "-m", "base"]);
}

describe("cherryPickCommits", () => {
  it("skips duplicate commits before touching the working tree", async () => {
    const duplicate: SourceCommit = {
      sha: "abc123",
      title: "already ported",
      message: "already ported\n",
    };

    await expect(
      cherryPickCommits(
        { destDir: "/path/that/does/not/exist", secrets: [] },
        [duplicate],
        new Set([duplicate.sha]),
      ),
    ).resolves.toEqual({
      results: [{ sha: duplicate.sha, title: duplicate.title, status: "skipped" }],
      conflicts: [],
    });
  });

  it("applies non-duplicate commits and reports them in replay order", async () => {
    const root = await mkdtemp(join(tmpdir(), "gitport-cherry-unit-"));
    try {
      const repo = join(root, "repo");
      await gitNoCwd(["init", "-b", "main", repo]);
      await configureCleanRepo(repo);
      await git(repo, ["checkout", "-b", "source"]);
      await writeFile(join(repo, "feature.txt"), "one\n", "utf8");
      await git(repo, ["add", "feature.txt"]);
      await git(repo, ["commit", "-m", "add feature"]);
      const sha = (await git(repo, ["rev-parse", "HEAD"])).trim();
      const commit: SourceCommit = { sha, title: "add feature", message: "add feature\n" };
      await git(repo, ["checkout", "main"]);

      const result = await cherryPickCommits({ destDir: repo, secrets: [] }, [commit], new Set());

      expect(result.results).toEqual([{ sha, title: "add feature", status: "applied" }]);
      expect(result.conflicts).toEqual([]);
      await expect(readFile(join(repo, "feature.txt"), "utf8")).resolves.toBe("one\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("auto-resolves conflicts with incoming and returns conflict excerpts", async () => {
    const root = await mkdtemp(join(tmpdir(), "gitport-cherry-conflict-"));
    try {
      const repo = join(root, "repo");
      await gitNoCwd(["init", "-b", "main", repo]);
      await configureCleanRepo(repo);
      await git(repo, ["checkout", "-b", "source"]);
      await writeFile(join(repo, "app.txt"), "value=incoming\n", "utf8");
      await git(repo, ["commit", "-am", "incoming change"]);
      const sha = (await git(repo, ["rev-parse", "HEAD"])).trim();
      const commit: SourceCommit = { sha, title: "incoming change", message: "incoming change\n" };
      await git(repo, ["checkout", "main"]);
      await writeFile(join(repo, "app.txt"), "value=old-destination\n", "utf8");
      await git(repo, ["commit", "-am", "destination change"]);

      const result = await cherryPickCommits({ destDir: repo, secrets: [] }, [commit], new Set());

      expect(result.results).toEqual([{ sha, title: "incoming change", status: "incoming-resolved" }]);
      expect(result.conflicts[0]?.files[0]?.oursExcerpt).toContain("old-destination");
      expect(result.conflicts[0]?.files[0]?.theirsExcerpt).toContain("incoming");
      await expect(readFile(join(repo, "app.txt"), "utf8")).resolves.toBe("value=incoming\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
