import { GITPORT_ERROR_CODE, GitportError } from "../errors.js";
import { maskAll } from "../mask.js";
import { encodeProjectPath } from "../repo-url.js";
import type {
  CreatedMergeRequest,
  GitLabCurrentUser,
  GitLabMergeRequestInfo,
  SourceCommit,
} from "../types.js";

import {
  ensureDraftTitle,
  nextPageFromHeaders,
  parseCommit,
  parseCreatedMergeRequest,
  parseCurrentUser,
  parseMergeRequest,
} from "./response.js";

export type FetchLike = typeof fetch;

export interface GitLabClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchFn?: FetchLike | undefined;
}

export interface CreateDraftMergeRequestInput {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly title: string;
  readonly description: string;
  readonly assigneeId: number;
}

interface RequestOptions {
  readonly method?: string | undefined;
  readonly body?: unknown;
}

interface JsonResponse {
  readonly value: unknown;
  readonly headers: Headers;
}

interface GitLabRequestContext {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchFn: FetchLike;
  readonly secrets: readonly string[];
}

export class GitLabHttpError extends GitportError {
  public readonly status: number;

  public constructor(status: number, detail: string) {
    super(GITPORT_ERROR_CODE.GitLabFailed, `GitLab request failed (${status.toString()}): ${detail}`);
    this.name = "GitLabHttpError";
    this.status = status;
  }
}

export interface GitLabClient {
  getCurrentUser: () => Promise<GitLabCurrentUser>;
  getMergeRequest: (projectPath: string, iid: number) => Promise<GitLabMergeRequestInfo>;
  listMergeRequestCommits: (projectPath: string, iid: number) => Promise<readonly SourceCommit[]>;
  createDraftMergeRequest: (
    projectPath: string,
    input: CreateDraftMergeRequestInput,
  ) => Promise<CreatedMergeRequest>;
}

function createRequestContext(options: GitLabClientOptions): GitLabRequestContext {
  return {
    baseUrl: options.baseUrl.replace(/\/+$/, ""),
    token: options.token,
    fetchFn: options.fetchFn ?? fetch,
    secrets: [options.token],
  };
}

function buildRequestInit(context: GitLabRequestContext, requestOptions: RequestOptions): RequestInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "PRIVATE-TOKEN": context.token,
  };
  const init: RequestInit = { method: requestOptions.method ?? "GET", headers };
  if (requestOptions.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(requestOptions.body);
  }
  return init;
}

async function requestJsonResponse(
  context: GitLabRequestContext,
  path: string,
  requestOptions: RequestOptions = {},
): Promise<JsonResponse> {
  const response = await context.fetchFn(
    `${context.baseUrl}${path}`,
    buildRequestInit(context, requestOptions),
  );
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new GitLabHttpError(response.status, maskAll(text || response.statusText, context.secrets));
  }
  return { value: await response.json(), headers: response.headers };
}

async function requestJson(
  context: GitLabRequestContext,
  path: string,
  requestOptions: RequestOptions = {},
): Promise<unknown> {
  return (await requestJsonResponse(context, path, requestOptions)).value;
}

async function requestArrayPage(
  context: GitLabRequestContext,
  path: string,
): Promise<{ readonly value: readonly unknown[]; readonly nextPage: string | undefined }> {
  const response = await requestJsonResponse(context, path);
  if (!Array.isArray(response.value)) {
    throw new GitportError(GITPORT_ERROR_CODE.GitLabFailed, "GitLab commits response is not an array");
  }
  return { value: response.value, nextPage: nextPageFromHeaders(response.headers) };
}

async function fetchMergeRequest(
  context: GitLabRequestContext,
  projectPath: string,
  iid: number,
): Promise<GitLabMergeRequestInfo> {
  const encodedProject = encodeProjectPath(projectPath);
  const value = await requestJson(
    context,
    `/projects/${encodedProject}/merge_requests/${iid.toString()}`,
  );
  return parseMergeRequest(value);
}

async function fetchCurrentUser(context: GitLabRequestContext): Promise<GitLabCurrentUser> {
  return parseCurrentUser(await requestJson(context, "/user"));
}

async function fetchMergeRequestCommits(
  context: GitLabRequestContext,
  projectPath: string,
  iid: number,
): Promise<readonly SourceCommit[]> {
  const encodedProject = encodeProjectPath(projectPath);
  const commits: SourceCommit[] = [];
  let page: string | undefined = "1";
  while (page !== undefined) {
    const response = await requestArrayPage(
      context,
      `/projects/${encodedProject}/merge_requests/${iid.toString()}/commits?per_page=100&page=${page}`,
    );
    commits.push(...response.value.map((entry) => parseCommit(entry)));
    page = response.nextPage;
  }
  return commits;
}

async function postDraftMergeRequest(
  context: GitLabRequestContext,
  projectPath: string,
  input: CreateDraftMergeRequestInput,
): Promise<CreatedMergeRequest> {
  const encodedProject = encodeProjectPath(projectPath);
  const value = await requestJson(
    context,
    `/projects/${encodedProject}/merge_requests`,
    {
      method: "POST",
      body: {
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title: ensureDraftTitle(input.title),
        description: input.description,
        draft: true,
        assignee_ids: [input.assigneeId],
        remove_source_branch: false,
      },
    },
  );
  return parseCreatedMergeRequest(value);
}

export function createGitLabClient(options: GitLabClientOptions): GitLabClient {
  const context = createRequestContext(options);
  return {
    getCurrentUser: () => fetchCurrentUser(context),
    getMergeRequest: (projectPath, iid) => fetchMergeRequest(context, projectPath, iid),
    listMergeRequestCommits: (projectPath, iid) =>
      fetchMergeRequestCommits(context, projectPath, iid),
    createDraftMergeRequest: (projectPath, input) =>
      postDraftMergeRequest(context, projectPath, input),
  };
}
