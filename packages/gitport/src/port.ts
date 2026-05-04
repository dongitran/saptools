import { mkdir, rm, writeFile } from "node:fs/promises";

import { GITPORT_ERROR_CODE, GitportError } from "./errors.js";
import {
  buildGitCredentialEnv,
  listPatchEquivalentCommits,
  orderCommitsBySourceHistory,
  runGit,
  GitCommandError,
  validatePortBranches,
} from "./git.js";
import type { GitRunOptions } from "./git.js";
import { createGitLabClient } from "./gitlab.js";
import type { GitLabClient } from "./gitlab.js";
import { maskAll } from "./mask.js";
import { writeRunMetadata } from "./metadata.js";
import { createRunId, runPaths } from "./paths.js";
import { cherryPickCommits } from "./port-cherry-pick.js";
import { parseRepoRef } from "./repo-url.js";
import { buildDraftMergeRequestDescription, buildReportMarkdown } from "./report.js";
import type {
  CreatedMergeRequest,
  PortGitLabMergeRequestOptions,
  PortGitLabMergeRequestResult,
  RunMetadata,
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

interface PreparedDestination {
  readonly portBranchExisted: boolean;
}

interface FetchedSourceRef {
  readonly ref: string;
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
  const credentialEnv = source.kind === "http" || dest.kind === "http" ? buildGitCredentialEnv(token) : undefined;
  const gitEnv = credentialEnv === undefined ? options.env : { ...options.env, ...credentialEnv };
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

async function cloneAndPrepare(
  options: PortGitLabMergeRequestOptions,
  run: PreparedRun,
): Promise<PreparedDestination> {
  await mkdir(run.paths.runDir, { recursive: true });
  await runGit(["clone", run.destRemote, run.paths.destDir], gitOptions(run));
  await runGit(["fetch", "origin", options.baseBranch], gitOptions(run, run.paths.destDir));
  const portBranchExisted = await fetchExistingDestinationBranch(options, run);
  await runGit(["checkout", "-B", options.portBranch, destinationStartRef(options, portBranchExisted)], {
    ...gitOptions(run, run.paths.destDir),
  });
  return { portBranchExisted };
}

async function fetchExistingDestinationBranch(
  options: PortGitLabMergeRequestOptions,
  run: PreparedRun,
): Promise<boolean> {
  try {
    await runGit(
      ["fetch", "origin", `refs/heads/${options.portBranch}:refs/remotes/origin/${options.portBranch}`],
      gitOptions(run, run.paths.destDir),
    );
    return true;
  } catch (error: unknown) {
    if (error instanceof GitCommandError) {
      return false;
    }
    throw error;
  }
}

function destinationStartRef(options: PortGitLabMergeRequestOptions, portBranchExisted: boolean): string {
  return portBranchExisted ? `origin/${options.portBranch}` : `origin/${options.baseBranch}`;
}

async function fetchSourceBranch(
  options: PortGitLabMergeRequestOptions,
  run: PreparedRun,
  sourceBranch: string,
): Promise<FetchedSourceRef> {
  await runGit(["remote", "add", "gitport-source", run.sourceRemote], {
    ...gitOptions(run, run.paths.destDir),
  });
  const sourceRef = await fetchSourceBranchRef(options, run, sourceBranch);
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
  return { ref: sourceRef };
}

async function fetchSourceBranchRef(
  options: PortGitLabMergeRequestOptions,
  run: PreparedRun,
  sourceBranch: string,
): Promise<string> {
  const branchRef = `refs/remotes/gitport-source/${sourceBranch}`;
  try {
    await runGit(
      ["fetch", "gitport-source", `refs/heads/${sourceBranch}:${branchRef}`],
      gitOptions(run, run.paths.destDir),
    );
    return branchRef;
  } catch (error: unknown) {
    if (!(error instanceof GitCommandError)) {
      throw error;
    }
  }

  const mergeRequestHeadRef = `refs/remotes/gitport-source/merge-requests/${options.sourceMergeRequestIid.toString()}/head`;
  await runGit(
    [
      "fetch",
      "gitport-source",
      `refs/merge-requests/${options.sourceMergeRequestIid.toString()}/head:${mergeRequestHeadRef}`,
    ],
    gitOptions(run, run.paths.destDir),
  );
  return mergeRequestHeadRef;
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
  const [sourceMr, commits] = await Promise.all([
    client.getMergeRequest(run.source.projectPath, options.sourceMergeRequestIid),
    client.listMergeRequestCommits(run.source.projectPath, options.sourceMergeRequestIid),
  ]);

  const destination = await cloneAndPrepare(options, run);
  const sourceRef = await fetchSourceBranch(options, run, sourceMr.sourceBranch);
  const orderedCommits = await orderCommitsBySourceHistory(
    run.paths.destDir,
    commits,
    "HEAD",
    sourceRef.ref,
    run.secrets,
  );
  const duplicateShas = await listPatchEquivalentCommits(
    run.paths.destDir,
    "HEAD",
    sourceRef.ref,
    run.secrets,
  );
  const { results, conflicts } = await cherryPickCommits(
    { destDir: run.paths.destDir, gitEnv: run.gitEnv, secrets: run.secrets },
    orderedCommits,
    duplicateShas,
  );
  await runGit(["push", "-u", "origin", options.portBranch], gitOptions(run, run.paths.destDir));

  const descriptionInput = {
    sourceMergeRequestIid: options.sourceMergeRequestIid,
    sourceMergeRequestTitle: sourceMr.title,
    sourceMergeRequestUrl: sourceMr.webUrl,
    conflicts,
  };
  const mergeRequest = destination.portBranchExisted
    ? undefined
    : await createDraftMergeRequest(options, run, client, descriptionInput);
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
    ...(mergeRequest === undefined
      ? {}
      : {
        mergeRequestUrl: mergeRequest.webUrl,
        mergeRequestIid: mergeRequest.iid,
      }),
  });
  if (options.keepWorkdir !== true) {
    await rm(run.paths.runDir, { recursive: true, force: true });
  }
  return {
    runId: run.runId,
    runDir: run.paths.runDir,
    destDir: run.paths.destDir,
    baseBranch: options.baseBranch,
    portBranch: options.portBranch,
    portBranchExisted: destination.portBranchExisted,
    mergeRequestCreated: mergeRequest !== undefined,
    ...(mergeRequest === undefined
      ? {}
      : {
        mergeRequestUrl: mergeRequest.webUrl,
        mergeRequestIid: mergeRequest.iid,
      }),
    commits: results,
    conflicts,
  };
}

async function createDraftMergeRequest(
  options: PortGitLabMergeRequestOptions,
  run: PreparedRun,
  client: GitLabClient,
  descriptionInput: Parameters<typeof buildDraftMergeRequestDescription>[0],
): Promise<CreatedMergeRequest> {
  const currentUser = await client.getCurrentUser();
  return await client.createDraftMergeRequest(run.dest.projectPath, {
    sourceBranch: options.portBranch,
    targetBranch: options.baseBranch,
    title: options.title,
    description: buildDraftMergeRequestDescription(descriptionInput),
    assigneeId: currentUser.id,
  });
}

export function maskGitportError(error: unknown, secrets: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  return maskAll(message, secrets);
}
