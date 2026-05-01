import { GITPORT_ERROR_CODE, GitportError } from "./errors.js";
import { GitCommandError, runGit } from "./git.js";
import type { GitRunOptions } from "./git.js";
import type { ConflictReport } from "./types.js";

const EXCERPT_MAX_CHARS = 4000;
const EXCERPT_MAX_LINES = 80;

function splitNul(value: string): readonly string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

function trimExcerpt(value: string | undefined): string {
  if (value === undefined) {
    return "(missing)";
  }
  const byLine = value.split("\n").slice(0, EXCERPT_MAX_LINES).join("\n");
  const excerpt = byLine.length > EXCERPT_MAX_CHARS ? byLine.slice(0, EXCERPT_MAX_CHARS) : byLine;
  return excerpt.length === value.length ? excerpt : `${excerpt}\n... [truncated]`;
}

async function readStage(cwd: string, stage: 2 | 3, path: string): Promise<string | undefined> {
  try {
    const result = await runGit(["show", `:${stage.toString()}:${path}`], { cwd });
    return result.stdout;
  } catch (error: unknown) {
    if (error instanceof GitCommandError) {
      return undefined;
    }
    throw error;
  }
}

export async function listUnmergedFiles(cwd: string): Promise<readonly string[]> {
  const result = await runGit(["diff", "--name-only", "--diff-filter=U", "-z"], { cwd });
  return splitNul(result.stdout);
}

export async function captureConflict(
  cwd: string,
  input: { readonly commitSha: string; readonly commitTitle: string },
): Promise<ConflictReport> {
  const paths = await listUnmergedFiles(cwd);
  const files = await Promise.all(
    paths.map(async (path) => ({
      path,
      oursExcerpt: trimExcerpt(await readStage(cwd, 2, path)),
      theirsExcerpt: trimExcerpt(await readStage(cwd, 3, path)),
    })),
  );
  return { commitSha: input.commitSha, commitTitle: input.commitTitle, files };
}

async function checkoutIncoming(cwd: string, path: string, options: GitRunOptions): Promise<void> {
  const runOptions = { cwd, env: options.env, secrets: options.secrets };
  try {
    await runGit(["checkout", "--theirs", "--", path], runOptions);
  } catch (error: unknown) {
    if (!(error instanceof GitCommandError)) {
      throw error;
    }
    await runGit(["rm", "--ignore-unmatch", "--", path], runOptions);
    return;
  }
  await runGit(["add", "--", path], runOptions);
}

export function isEmptyCherryPickMessage(detail: string): boolean {
  return detail.includes("previous cherry-pick is now empty") || detail.includes("nothing to commit");
}

async function continueCherryPick(cwd: string, options: GitRunOptions): Promise<void> {
  const runOptions = { cwd, env: options.env, secrets: options.secrets };
  try {
    await runGit(["cherry-pick", "--continue"], runOptions);
  } catch (error: unknown) {
    if (error instanceof GitCommandError && isEmptyCherryPickMessage(error.stderr)) {
      await runGit(["cherry-pick", "--skip"], runOptions);
      return;
    }
    throw error;
  }
}

export async function autoResolveIncomingConflict(
  cwd: string,
  input: {
    readonly commitSha: string;
    readonly commitTitle: string;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly secrets: readonly string[];
  },
): Promise<ConflictReport> {
  const conflict = await captureConflict(cwd, input);
  if (conflict.files.length === 0) {
    throw new GitportError(GITPORT_ERROR_CODE.GitFailed, "Cannot resolve incoming conflict: no unmerged files found");
  }
  await conflict.files.reduce(
    async (previous, file): Promise<void> => {
      await previous;
      await checkoutIncoming(cwd, file.path, { env: input.env, secrets: input.secrets });
    },
    Promise.resolve(),
  );
  await continueCherryPick(cwd, { env: input.env, secrets: input.secrets });
  return conflict;
}
