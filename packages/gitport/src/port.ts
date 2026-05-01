import { mkdir, rm, writeFile } from "node:fs/promises";

import { GITPORT_ERROR_CODE, GitportError } from "./errors.js";
import {
  autoResolveIncomingConflict,
  buildGitCredentialEnv,
  gitHead,
  isEmptyCherryPickMessage,
  listPatchEquivalentCommits,
  orderCommitsBySourceHistory,
  runGit,
  GitCommandError,
  validatePortBranches,
} from "./git.js";
import type { GitRunOptions } from "./git.js";
import { createGitLabClient } from "./gitlab.js";
import { maskAll } from "./mask.js";
import { writeRunMetadata } from "./metadata.js";
import { createRunId, runPaths } from "./paths.js";
import { parseRepoRef } from "./repo-url.js";
import { buildDraftMergeRequestDescription, buildReportMarkdown } from "./report.js";
import type {
  CommitPortResult,
  ConflictReport,
  PortGitLabMergeRequestOptions,
  PortGitLabMergeRequestResult,
  RunMetadata,
  SourceCommit,
} from "./types.js";
import { GITPORT_GITLAB_API_BASE_ENV, GITPORT_GITLAB_TOKEN_ENV } from "./types.js";

interface PreparedRun {
  readonly runId: string;
  readonly paths: ReturnType<typeof runPaths>;
  readonly token: string;
  readonly secrets: readonly string[];
  readonly source: ReturnType<typeof parseRepoRef>;
  readonly dest: ReturnType<typeof parseRepoRef>;
  readonly sourceRemote: string;
  readonly destRemote: string;
  readonly gitEnv?: NodeJS.ProcessEnv | undefined;
  readonly gitlabApiBase: string;
}

interface CherryPickState {
  readonly results: readonly CommitPortResult[];
  readonly conflicts: readonly ConflictReport[];
}

function resolveToken(options: PortGitLabMergeRequestOptions): string {
  const token = options.token ?? options.env?.[GITPORT_GITLAB_TOKEN_ENV] ?? process.env[GITPORT_GITLAB_TOKEN_ENV];
  if (token === undefined || token.length === 0) {
    throw new GitportError(
      GITPORT_ERROR_CODE.MissingToken,
      `GitLab token is required (pass --token or set ${GITPORT_GITLAB_TOKEN_ENV})`,
    );
  }
  return token;
}

function resolveApiBase(
  options: PortGitLabMergeRequestOptions,
  sourceDefault: string | undefined,
): string {
  const base =
    options.gitlabApiBase ??
    options.env?.[GITPORT_GITLAB_API_BASE_ENV] ??
    process.env[GITPORT_GITLAB_API_BASE_ENV] ??
    sourceDefault;
  if (base === undefined || base.length === 0) {
    throw new GitportError(
      GITPORT_ERROR_CODE.InvalidInput,
      `GitLab API base cannot be inferred; pass --gitlab-api-base or set ${GITPORT_GITLAB_API_BASE_ENV}`,
    );
  }
  return base;
}

function prepareRun(options: PortGitLabMergeRequestOptions): PreparedRun {
  const token = resolveToken(options);
  const source = parseRepoRef(options.sourceRepo);
  const dest = parseRepoRef(options.destRepo);
  const runId = options.runId ?? createRunId();
  const gitEnv = source.kind === "http" || dest.kind === "http" ? buildGitCredentialEnv(token) : undefined;
  return {
    runId,
    paths: runPaths(runId, options.workRoot),
    token,
    secrets: [token],
    source,
    dest,
    sourceRemote: options.sourceRepo,
    destRemote: options.destRepo,
    ...(gitEnv === undefined ? {} : { gitEnv }),
    gitlabApiBase: resolveApiBase(options, source.defaultApiBase),
  };
}

function gitOptions(
  run: PreparedRun,
  cwd?: string,
): GitRunOptions {
  return {
    ...(cwd === undefined ? {} : { cwd }),
    secrets: run.secrets,
    ...(run.gitEnv === undefined ? {} : { env: run.gitEnv }),
  };
}

async function writeMetadata(
  options: PortGitLabMergeRequestOptions,
  run: PreparedRun,
  metadata: RunMetadata,
): Promise<void> {
  await writeRunMetadata({ workRoot: options.workRoot, metadata });
}

async function cloneAndPrepare(options: PortGitLabMergeRequestOptions, run: PreparedRun): Promise<void> {
  await mkdir(run.paths.runDir, { recursive: true });
  await runGit(["clone", run.destRemote, run.paths.destDir], gitOptions(run));
  await ensurePortBranchDoesNotExist(options, run);
  await runGit(["fetch", "origin", options.baseBranch], gitOptions(run, run.paths.destDir));
  await runGit(["checkout", "-B", options.portBranch, `origin/${options.baseBranch}`], {
    ...gitOptions(run, run.paths.destDir),
  });
}

async function ensurePortBranchDoesNotExist(
  options: PortGitLabMergeRequestOptions,
  run: PreparedRun,
): Promise<void> {
  try {
    await runGit(
      ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${options.portBranch}`],
      gitOptions(run, run.paths.destDir),
    );
  } catch (error: unknown) {
    if (error instanceof GitCommandError) {
      return;
    }
    throw error;
  }
  throw new GitportError(
    GITPORT_ERROR_CODE.InvalidInput,
    `Port branch already exists in destination: ${options.portBranch}`,
  );
}

async function fetchSourceBranch(
  options: PortGitLabMergeRequestOptions,
  run: PreparedRun,
  sourceBranch: string,
): Promise<void> {
  await runGit(["remote", "add", "gitport-source", run.sourceRemote], {
    ...gitOptions(run, run.paths.destDir),
  });
  await runGit(
    ["fetch", "gitport-source", `${sourceBranch}:refs/remotes/gitport-source/${sourceBranch}`],
    gitOptions(run, run.paths.destDir),
  );
  await writeMetadata(options, run, {
    runId: run.runId,
    runDir: run.paths.runDir,
    destDir: run.paths.destDir,
    status: "running",
    sourceRepo: options.sourceRepo,
    destRepo: options.destRepo,
    sourceMergeRequestIid: options.sourceMergeRequestIid,
    baseBranch: options.baseBranch,
    portBranch: options.portBranch,
  });
}

async function cherryPickCommit(
  run: PreparedRun,
  commit: SourceCommit,
): Promise<{ readonly result: CommitPortResult; readonly conflict?: ConflictReport | undefined }> {
  const before = await gitHead(run.paths.destDir);
  try {
    await runGit(["cherry-pick", "-x", commit.sha], gitOptions(run, run.paths.destDir));
  } catch (error: unknown) {
    if (!(error instanceof GitCommandError)) {
      throw error;
    }
    const unmerged = await runGit(["diff", "--name-only", "--diff-filter=U"], {
      ...gitOptions(run, run.paths.destDir),
    });
    if (unmerged.stdout.trim().length === 0) {
      if (!isEmptyCherryPickMessage(error.stderr)) {
        throw error;
      }
      await runGit(["cherry-pick", "--skip"], gitOptions(run, run.paths.destDir));
      return { result: { sha: commit.sha, title: commit.title, status: "skipped" } };
    }
    const conflict = await autoResolveIncomingConflict(run.paths.destDir, {
      commitSha: commit.sha,
      commitTitle: commit.title,
      secrets: run.secrets,
    });
    return {
      result: { sha: commit.sha, title: commit.title, status: "incoming-resolved" },
      conflict,
    };
  }
  const after = await gitHead(run.paths.destDir);
  const status: CommitPortResult["status"] = before === after ? "skipped" : "applied";
  return { result: { sha: commit.sha, title: commit.title, status } };
}

async function cherryPickCommits(
  run: PreparedRun,
  commits: readonly SourceCommit[],
  duplicateShas: ReadonlySet<string>,
): Promise<{ readonly results: readonly CommitPortResult[]; readonly conflicts: readonly ConflictReport[] }> {
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

async function writeReports(
  run: PreparedRun,
  input: Parameters<typeof buildDraftMergeRequestDescription>[0],
): Promise<void> {
  await writeFile(run.paths.reportMarkdownPath, `${buildReportMarkdown(input)}\n`, "utf8");
  await writeFile(run.paths.reportJsonPath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
}

export async function portGitLabMergeRequest(
  options: PortGitLabMergeRequestOptions,
): Promise<PortGitLabMergeRequestResult> {
  await validatePortBranches(options.baseBranch, options.portBranch);
  const run = prepareRun(options);
  const client = createGitLabClient({
    baseUrl: run.gitlabApiBase,
    token: run.token,
    fetchFn: options.fetchFn,
  });
  const [sourceMr, commits, currentUser] = await Promise.all([
    client.getMergeRequest(run.source.projectPath, options.sourceMergeRequestIid),
    client.listMergeRequestCommits(run.source.projectPath, options.sourceMergeRequestIid),
    client.getCurrentUser(),
  ]);

  await cloneAndPrepare(options, run);
  await fetchSourceBranch(options, run, sourceMr.sourceBranch);
  const sourceRef = `refs/remotes/gitport-source/${sourceMr.sourceBranch}`;
  const orderedCommits = await orderCommitsBySourceHistory(
    run.paths.destDir,
    commits,
    "HEAD",
    sourceRef,
    run.secrets,
  );
  const duplicateShas = await listPatchEquivalentCommits(
    run.paths.destDir,
    "HEAD",
    sourceRef,
    run.secrets,
  );
  const { results, conflicts } = await cherryPickCommits(run, orderedCommits, duplicateShas);
  await runGit(["push", "-u", "origin", options.portBranch], gitOptions(run, run.paths.destDir));

  const descriptionInput = {
    sourceMergeRequestIid: options.sourceMergeRequestIid,
    sourceMergeRequestTitle: sourceMr.title,
    sourceMergeRequestUrl: sourceMr.webUrl,
    conflicts,
  };
  const mergeRequest = await client.createDraftMergeRequest(run.dest.projectPath, {
    sourceBranch: options.portBranch,
    targetBranch: options.baseBranch,
    title: options.title,
    description: buildDraftMergeRequestDescription(descriptionInput),
    assigneeId: currentUser.id,
  });
  await writeReports(run, descriptionInput);
  await writeMetadata(options, run, {
    runId: run.runId,
    runDir: run.paths.runDir,
    destDir: run.paths.destDir,
    status: "completed",
    sourceRepo: options.sourceRepo,
    destRepo: options.destRepo,
    sourceMergeRequestIid: options.sourceMergeRequestIid,
    baseBranch: options.baseBranch,
    portBranch: options.portBranch,
    mergeRequestUrl: mergeRequest.webUrl,
    mergeRequestIid: mergeRequest.iid,
  });
  if (options.keepWorkdir !== true) {
    await rm(run.paths.runDir, { recursive: true, force: true });
  }
  return {
    runId: run.runId,
    runDir: run.paths.runDir,
    destDir: run.paths.destDir,
    mergeRequestUrl: mergeRequest.webUrl,
    mergeRequestIid: mergeRequest.iid,
    commits: results,
    conflicts,
  };
}

export function maskGitportError(error: unknown, secrets: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  return maskAll(message, secrets);
}
