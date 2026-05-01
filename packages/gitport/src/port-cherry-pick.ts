import { autoResolveIncomingConflict, isEmptyCherryPickMessage } from "./git-conflicts.js";
import {
  GitCommandError,
  gitHead,
  runGit,
  type GitRunOptions,
} from "./git.js";
import type { CommitPortResult, ConflictReport, SourceCommit } from "./types.js";

export interface CherryPickRunContext {
  readonly destDir: string;
  readonly gitEnv?: NodeJS.ProcessEnv | undefined;
  readonly secrets: readonly string[];
}

export interface CherryPickOutcome {
  readonly results: readonly CommitPortResult[];
  readonly conflicts: readonly ConflictReport[];
}

interface CherryPickState {
  readonly results: readonly CommitPortResult[];
  readonly conflicts: readonly ConflictReport[];
}

function gitOptions(run: CherryPickRunContext): GitRunOptions {
  return {
    cwd: run.destDir,
    secrets: run.secrets,
    ...(run.gitEnv === undefined ? {} : { env: run.gitEnv }),
  };
}

async function cherryPickCommit(
  run: CherryPickRunContext,
  commit: SourceCommit,
): Promise<{ readonly result: CommitPortResult; readonly conflict?: ConflictReport | undefined }> {
  const before = await gitHead(run.destDir);
  try {
    await runGit(["cherry-pick", "-x", commit.sha], gitOptions(run));
  } catch (error: unknown) {
    if (!(error instanceof GitCommandError)) {
      throw error;
    }
    const unmerged = await runGit(["diff", "--name-only", "--diff-filter=U"], gitOptions(run));
    if (unmerged.stdout.trim().length === 0) {
      if (!isEmptyCherryPickMessage(error.stderr)) {
        throw error;
      }
      await runGit(["cherry-pick", "--skip"], gitOptions(run));
      return { result: { sha: commit.sha, title: commit.title, status: "skipped" } };
    }
    const conflict = await autoResolveIncomingConflict(run.destDir, {
      commitSha: commit.sha,
      commitTitle: commit.title,
      env: run.gitEnv,
      secrets: run.secrets,
    });
    return {
      result: { sha: commit.sha, title: commit.title, status: "incoming-resolved" },
      conflict,
    };
  }
  const after = await gitHead(run.destDir);
  const status: CommitPortResult["status"] = before === after ? "skipped" : "applied";
  return { result: { sha: commit.sha, title: commit.title, status } };
}

export async function cherryPickCommits(
  run: CherryPickRunContext,
  commits: readonly SourceCommit[],
  duplicateShas: ReadonlySet<string>,
): Promise<CherryPickOutcome> {
  const initialState: Promise<CherryPickState> = Promise.resolve({
    results: [],
    conflicts: [],
  });
  const outcomes = await commits.reduce<Promise<CherryPickState>>(
    async (previous, commit): Promise<CherryPickState> => {
      const state = await previous;
      if (duplicateShas.has(commit.sha)) {
        const skipped: CommitPortResult = { sha: commit.sha, title: commit.title, status: "skipped" };
        return {
          results: [...state.results, skipped],
          conflicts: state.conflicts,
        };
      }
      const outcome = await cherryPickCommit(run, commit);
      return {
        results: [...state.results, outcome.result],
        conflicts: outcome.conflict === undefined ? state.conflicts : [...state.conflicts, outcome.conflict],
      };
    },
    initialState,
  );
  return outcomes;
}
