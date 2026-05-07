import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import type { CommandResult, Repo } from "../types.js";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;

export async function runGit(
  repoPath: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync("git", [...args], { cwd: repoPath, maxBuffer: MAX_BUFFER });
}

export async function runShellCmd(
  repoPath: string,
  command: string,
): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync("sh", ["-c", command], { cwd: repoPath, maxBuffer: MAX_BUFFER });
}

export async function runGitInteractive(repoPath: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", [...args], { cwd: repoPath, stdio: "inherit" });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`git exited with code ${String(code)}`));
      }
    });
    child.on("error", reject);
  });
}

async function runAcrossRepos(
  repos: readonly Repo[],
  exec: (path: string) => Promise<{ stdout: string; stderr: string }>,
): Promise<CommandResult[]> {
  const settled = await Promise.allSettled(
    repos.map(async ({ name, path }) => {
      const { stdout, stderr } = await exec(path);
      return { name, output: (stdout + stderr).trim(), error: null } satisfies CommandResult;
    }),
  );

  return settled.map((result, i) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    const repo = repos[i];
    const reason: unknown = result.reason;
    return {
      name: repo?.name ?? `repo-${String(i)}`,
      output: "",
      error: reason instanceof Error ? reason.message : String(reason),
    } satisfies CommandResult;
  });
}

export async function runGitAcrossRepos(
  repos: readonly Repo[],
  args: readonly string[],
): Promise<CommandResult[]> {
  return await runAcrossRepos(repos, (path) => runGit(path, args));
}

export async function runShellAcrossRepos(
  repos: readonly Repo[],
  command: string,
): Promise<CommandResult[]> {
  return await runAcrossRepos(repos, (path) => runShellCmd(path, command));
}
