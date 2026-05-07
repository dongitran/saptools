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

export async function runGitAcrossRepos(
  repos: readonly Repo[],
  args: readonly string[],
): Promise<CommandResult[]> {
  const settled = await Promise.allSettled(
    repos.map(async ({ name, path }) => {
      const { stdout, stderr } = await runGit(path, args);
      return { name, output: (stdout + stderr).trim(), error: null } satisfies CommandResult;
    }),
  );

  return settled.map((result, i) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    const repo = repos[i];
    return {
      name: repo?.name ?? `repo-${String(i)}`,
      output: "",
      error: String(result.reason),
    } satisfies CommandResult;
  });
}

export async function runShellAcrossRepos(
  repos: readonly Repo[],
  command: string,
): Promise<CommandResult[]> {
  const settled = await Promise.allSettled(
    repos.map(async ({ name, path }) => {
      const { stdout, stderr } = await runShellCmd(path, command);
      return { name, output: (stdout + stderr).trim(), error: null } satisfies CommandResult;
    }),
  );

  return settled.map((result, i) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    const repo = repos[i];
    return {
      name: repo?.name ?? `repo-${String(i)}`,
      output: "",
      error: String(result.reason),
    } satisfies CommandResult;
  });
}
