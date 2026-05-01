import { execFile } from "node:child_process";
import process from "node:process";

import { GITPORT_ERROR_CODE, GitportError } from "./errors.js";
import { maskAll } from "./mask.js";
import type { ConflictReport, SourceCommit } from "./types.js";

const MAX_BUFFER = 32 * 1024 * 1024;
const EXCERPT_MAX_CHARS = 4000;
const EXCERPT_MAX_LINES = 80;
export const GITPORT_GIT_CREDENTIAL_TOKEN_ENV = "GITPORT_GIT_CREDENTIAL_TOKEN";

// cspell:ignore topo
const GIT_TOPOLOGICAL_ORDER_FLAG = "--topo-order";
const GIT_CREDENTIAL_HELPER_CONFIG =
  `!f() { if test "$1" = get; then printf '%s\\n' username=oauth2 ` +
  `password="$${GITPORT_GIT_CREDENTIAL_TOKEN_ENV}"; fi; }; f`;

export interface GitRunOptions {
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly secrets?: readonly string[] | undefined;
}

export interface GitRunResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface ExecError extends Error {
  readonly code?: number | string;
  readonly stdout?: string | Buffer;
  readonly stderr?: string | Buffer;
}

export class GitCommandError extends GitportError {
  public readonly stdout: string;
  public readonly stderr: string;

  public constructor(message: string, stdout: string, stderr: string, options?: ErrorOptions) {
    super(GITPORT_ERROR_CODE.GitFailed, message, options);
    this.name = "GitCommandError";
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function toText(value: string | Buffer | undefined): string {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return value ?? "";
}

function buildGitEnv(options: GitRunOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...options.env,
    GIT_EDITOR: "true",
  };
}

export function buildGitCredentialEnv(token: string): NodeJS.ProcessEnv {
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: GIT_CREDENTIAL_HELPER_CONFIG,
    [GITPORT_GIT_CREDENTIAL_TOKEN_ENV]: token,
  };
}

export async function runGit(
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<GitRunResult> {
  return await new Promise<GitRunResult>((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd: options.cwd, env: buildGitEnv(options), maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr });
          return;
        }
        const execError = error as ExecError;
        const stdoutText = toText(execError.stdout) || stdout;
        const stderrText = toText(execError.stderr) || stderr;
        const secrets = options.secrets ?? [];
        const command = maskAll(`git ${args.join(" ")}`, secrets);
        const detail = maskAll(stderrText || execError.message, secrets);
        reject(new GitCommandError(`${command} failed: ${detail}`, stdoutText, stderrText));
      },
    );
  });
}

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

export async function listPatchEquivalentCommits(
  cwd: string,
  upstreamRef: string,
  headRef: string,
  secrets: readonly string[] = [],
): Promise<ReadonlySet<string>> {
  const result = await runGit(["cherry", upstreamRef, headRef], { cwd, secrets });
  const duplicateShas = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((sha) => sha.length > 0);
  return new Set(duplicateShas);
}

function isPreRejectedBranchName(branch: string): boolean {
  return (
    branch.length === 0 ||
    branch.trim() !== branch ||
    branch.startsWith("-") ||
    branch.includes("@{")
  );
}

function invalidBranchError(label: string, branch: string): GitportError {
  return new GitportError(
    GITPORT_ERROR_CODE.InvalidInput,
    `${label} is not a valid branch name: ${branch}`,
  );
}

export async function validateBranchName(branch: string, label: string): Promise<void> {
  if (isPreRejectedBranchName(branch)) {
    throw invalidBranchError(label, branch);
  }
  try {
    await runGit(["check-ref-format", "--branch", branch]);
  } catch (error: unknown) {
    if (error instanceof GitCommandError) {
      throw invalidBranchError(label, branch);
    }
    throw error;
  }
}

export async function validatePortBranches(baseBranch: string, portBranch: string): Promise<void> {
  await Promise.all([
    validateBranchName(baseBranch, "Base branch"),
    validateBranchName(portBranch, "Port branch"),
  ]);
  if (baseBranch === portBranch) {
    throw new GitportError(
      GITPORT_ERROR_CODE.InvalidInput,
      "Base branch and port branch must differ",
    );
  }
}

async function sourceHistoryRange(
  cwd: string,
  upstreamRef: string,
  sourceRef: string,
  secrets: readonly string[],
): Promise<string> {
  try {
    const mergeBase = await runGit(["merge-base", upstreamRef, sourceRef], { cwd, secrets });
    const base = mergeBase.stdout.trim();
    return base.length === 0 ? sourceRef : `${base}..${sourceRef}`;
  } catch (error: unknown) {
    if (error instanceof GitCommandError) {
      return sourceRef;
    }
    throw error;
  }
}

export async function orderCommitsBySourceHistory(
  cwd: string,
  commits: readonly SourceCommit[],
  upstreamRef: string,
  sourceRef: string,
  secrets: readonly string[] = [],
): Promise<readonly SourceCommit[]> {
  if (commits.length === 0) {
    return commits;
  }
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const range = await sourceHistoryRange(cwd, upstreamRef, sourceRef, secrets);
  const history = await runGit(["rev-list", "--reverse", GIT_TOPOLOGICAL_ORDER_FLAG, range], {
    cwd,
    secrets,
  });
  const ordered = history.stdout
    .split("\n")
    .map((line) => line.trim())
    .reduce<SourceCommit[]>((current, sha) => {
      const commit = bySha.get(sha);
      return commit === undefined ? current : [...current, commit];
    }, []);
  if (ordered.length !== commits.length) {
    throw new GitportError(
      GITPORT_ERROR_CODE.GitFailed,
      "GitLab MR commits are not reachable from the fetched source branch",
    );
  }
  return ordered;
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

export async function gitHead(cwd: string): Promise<string> {
  const result = await runGit(["rev-parse", "HEAD"], { cwd });
  return result.stdout.trim();
}
