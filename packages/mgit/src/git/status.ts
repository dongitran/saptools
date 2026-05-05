import type { BranchStatus, GitStatusInfo } from "../types.js";

import { runGit } from "./runner.js";

export async function getGitStatus(repoPath: string): Promise<GitStatusInfo> {
  const { stdout } = await runGit(repoPath, ["status", "--porcelain=v2", "--branch"]);
  const base = parseGitStatusPorcelain(stdout);
  const stashed = await hasStash(repoPath);
  return { ...base, stashed };
}

export function parseGitStatusPorcelain(output: string): Omit<GitStatusInfo, "stashed"> {
  const lines = output.split("\n");

  let branch = "HEAD";
  let ahead = 0;
  let behind = 0;
  let hasUpstream = false;
  let staged = false;
  let unstaged = false;
  let untracked = false;

  for (const line of lines) {
    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length).trim();
    } else if (line.startsWith("# branch.upstream ")) {
      hasUpstream = true;
    } else if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(line);
      if (match) {
        ahead = parseInt(match[1] ?? "0", 10);
        behind = parseInt(match[2] ?? "0", 10);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const xy = line.slice(2, 4);
      if (xy.length > 0 && !xy.startsWith(".") && !xy.startsWith("?")) {
        staged = true;
      }
      const yChar = xy.slice(1);
      if (yChar.length > 0 && !yChar.startsWith(".") && !yChar.startsWith("?")) {
        unstaged = true;
      }
    } else if (line.startsWith("? ")) {
      untracked = true;
    }
  }

  const branchStatus = computeBranchStatus(hasUpstream, ahead, behind);

  return { branch, branchStatus, staged, unstaged, untracked, ahead, behind };
}

function computeBranchStatus(hasUpstream: boolean, ahead: number, behind: number): BranchStatus {
  if (!hasUpstream) {
    return "no_remote";
  }
  if (ahead > 0 && behind > 0) {
    return "diverged";
  }
  if (ahead > 0) {
    return "ahead";
  }
  if (behind > 0) {
    return "behind";
  }
  return "in_sync";
}

export async function hasStash(repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(repoPath, ["stash", "list"]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
