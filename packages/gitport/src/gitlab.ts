import { GITPORT_ERROR_CODE, GitportError } from "./errors.js";
import { maskAll } from "./mask.js";
import { encodeProjectPath } from "./repo-url.js";
import type { CreatedMergeRequest, GitLabMergeRequestInfo, SourceCommit } from "./types.js";

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
}

interface RequestOptions {
  readonly method?: string | undefined;
  readonly body?: unknown;
}

interface JsonResponse {
  readonly value: unknown;
  readonly headers: Headers;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isInteger(field) ? field : undefined;
}

function boolField(value: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}

function parseMergeRequest(value: unknown): GitLabMergeRequestInfo {
  if (!isRecord(value)) {
    throw new GitportError(GITPORT_ERROR_CODE.GitLabFailed, "GitLab MR response is not an object");
  }
  const iid = numberField(value, "iid");
  const title = stringField(value, "title");
  const sourceBranch = stringField(value, "source_branch");
  if (iid === undefined || title === undefined || sourceBranch === undefined) {
    throw new GitportError(GITPORT_ERROR_CODE.GitLabFailed, "GitLab MR response is missing fields");
  }
  return { iid, title, sourceBranch, webUrl: stringField(value, "web_url") };
}

function parseCommit(value: unknown): SourceCommit {
  if (!isRecord(value)) {
    throw new GitportError(GITPORT_ERROR_CODE.GitLabFailed, "GitLab commit response is not an object");
  }
  const sha = stringField(value, "id");
  const title = stringField(value, "title");
  const message = stringField(value, "message") ?? title;
  if (sha === undefined || title === undefined || message === undefined) {
    throw new GitportError(
      GITPORT_ERROR_CODE.GitLabFailed,
      "GitLab commit response is missing fields",
    );
  }
  return { sha, title, message };
}

function parseCreatedMergeRequest(value: unknown): CreatedMergeRequest {
  if (!isRecord(value)) {
    throw new GitportError(GITPORT_ERROR_CODE.GitLabFailed, "Created MR response is not an object");
  }
  const iid = numberField(value, "iid");
  const webUrl = stringField(value, "web_url");
  const draft = boolField(value, "draft") ?? true;
  if (iid === undefined || webUrl === undefined) {
    throw new GitportError(
      GITPORT_ERROR_CODE.GitLabFailed,
      "Created MR response is missing fields",
    );
  }
  return { iid, webUrl, draft };
}

function ensureDraftTitle(title: string): string {
  return title.startsWith("Draft:") ? title : `Draft: ${title}`;
}

function nextPageFromLinkHeader(linkHeader: string | null): string | undefined {
  if (linkHeader === null || linkHeader.length === 0) {
    return undefined;
  }
  const nextLink = linkHeader
    .split(",")
    .map((entry) => entry.trim())
    .find((entry) => entry.includes('rel="next"'));
  const nextUrl = /<([^>]+)>/.exec(nextLink ?? "")?.[1];
  if (nextUrl === undefined) {
    return undefined;
  }
  return new URL(nextUrl).searchParams.get("page") ?? undefined;
}

function nextPageFromHeaders(headers: Headers): string | undefined {
  const nextPage = headers.get("x-next-page")?.trim();
  if (nextPage !== undefined && nextPage.length > 0) {
    return nextPage;
  }
  return nextPageFromLinkHeader(headers.get("link"));
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
  getMergeRequest: (projectPath: string, iid: number) => Promise<GitLabMergeRequestInfo>;
  listMergeRequestCommits: (projectPath: string, iid: number) => Promise<readonly SourceCommit[]>;
  createDraftMergeRequest: (
    projectPath: string,
    input: CreateDraftMergeRequestInput,
  ) => Promise<CreatedMergeRequest>;
}

export function createGitLabClient(options: GitLabClientOptions): GitLabClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchFn = options.fetchFn ?? fetch;
  const secrets = [options.token];

  async function requestJsonResponse(
    path: string,
    requestOptions: RequestOptions = {},
  ): Promise<JsonResponse> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "PRIVATE-TOKEN": options.token,
    };
    const init: RequestInit = { method: requestOptions.method ?? "GET", headers };
    if (requestOptions.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(requestOptions.body);
    }

    const response = await fetchFn(`${baseUrl}${path}`, init);
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new GitLabHttpError(response.status, maskAll(text || response.statusText, secrets));
    }

    return { value: await response.json(), headers: response.headers };
  }

  async function requestJson(path: string, requestOptions: RequestOptions = {}): Promise<unknown> {
    return (await requestJsonResponse(path, requestOptions)).value;
  }

  async function requestArrayPage(
    path: string,
  ): Promise<{ readonly value: readonly unknown[]; readonly nextPage: string | undefined }> {
    const response = await requestJsonResponse(path);
    if (!Array.isArray(response.value)) {
      throw new GitportError(GITPORT_ERROR_CODE.GitLabFailed, "GitLab commits response is not an array");
    }
    return { value: response.value, nextPage: nextPageFromHeaders(response.headers) };
  }

  async function getMergeRequest(
    projectPath: string,
    iid: number,
  ): Promise<GitLabMergeRequestInfo> {
    const encodedProject = encodeProjectPath(projectPath);
    const value = await requestJson(`/projects/${encodedProject}/merge_requests/${iid.toString()}`);
    return parseMergeRequest(value);
  }

  async function listMergeRequestCommits(
    projectPath: string,
    iid: number,
  ): Promise<readonly SourceCommit[]> {
    const encodedProject = encodeProjectPath(projectPath);
    const commits: SourceCommit[] = [];
    let page: string | undefined = "1";
    while (page !== undefined) {
      const response = await requestArrayPage(
        `/projects/${encodedProject}/merge_requests/${iid.toString()}/commits?per_page=100&page=${page}`,
      );
      commits.push(...response.value.map((entry) => parseCommit(entry)));
      page = response.nextPage;
    }
    return commits;
  }

  async function createDraftMergeRequest(
    projectPath: string,
    input: CreateDraftMergeRequestInput,
  ): Promise<CreatedMergeRequest> {
    const encodedProject = encodeProjectPath(projectPath);
    const value = await requestJson(`/projects/${encodedProject}/merge_requests`, {
      method: "POST",
      body: {
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title: ensureDraftTitle(input.title),
        description: input.description,
        draft: true,
        remove_source_branch: false,
      },
    });
    return parseCreatedMergeRequest(value);
  }

  return { getMergeRequest, listMergeRequestCommits, createDraftMergeRequest };
}
