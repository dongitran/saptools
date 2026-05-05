import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { readRepos, writeRepos } from "../config/storage.js";
import { runGit } from "../git/runner.js";

export async function addRepo(inputPath: string, name?: string): Promise<void> {
  const absPath = resolve(inputPath);

  try {
    const s = await stat(absPath);
    if (!s.isDirectory()) {
      throw new Error(`Not a directory: ${absPath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Path does not exist: ${absPath}`, { cause: err });
    }
    throw err;
  }

  try {
    await runGit(absPath, ["rev-parse", "--git-dir"]);
  } catch {
    throw new Error(`Not a git repository: ${absPath}`);
  }

  const repoName = name ?? basename(absPath);
  const config = await readRepos();

  if (config.repos[repoName] !== undefined) {
    process.stdout.write(`Already tracked: ${repoName} → ${config.repos[repoName]}\n`);
    return;
  }

  const updated: typeof config = { repos: { ...config.repos, [repoName]: absPath } };
  await writeRepos(updated);
  process.stdout.write(`Added: ${repoName} → ${absPath}\n`);
}

export async function addRepoRecursive(rootPath: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const absRoot = resolve(rootPath);

  const { stdout } = await execFileAsync("find", [absRoot, "-name", ".git", "-type", "d"], {
    maxBuffer: 16 * 1024 * 1024,
  });

  const gitDirs = stdout.trim().split("\n").filter(Boolean);

  if (gitDirs.length === 0) {
    process.stdout.write(`No git repositories found under ${absRoot}\n`);
    return;
  }

  const config = await readRepos();
  const updatedRepos = { ...config.repos };
  let added = 0;

  for (const gitDir of gitDirs) {
    const repoPath = gitDir.replace(/[/\\]\.git$/, "");
    const repoName = basename(repoPath);
    const uniqueName = updatedRepos[repoName] === undefined ? repoName : repoPath;

    if (updatedRepos[uniqueName] !== undefined) {
      process.stdout.write(`Already tracked: ${uniqueName}\n`);
      continue;
    }

    updatedRepos[uniqueName] = repoPath;
    process.stdout.write(`Added: ${uniqueName} → ${repoPath}\n`);
    added++;
  }

  await writeRepos({ repos: updatedRepos });
  process.stdout.write(`\nDone. Added ${String(added)} repository(ies).\n`);
}
