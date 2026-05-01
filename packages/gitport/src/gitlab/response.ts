import { GITPORT_ERROR_CODE, GitportError } from "../errors.js";
import type {
  CreatedMergeRequest,
  GitLabCurrentUser,
  GitLabMergeRequestInfo,
  SourceCommit,
} from "../types.js";

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

export function parseMergeRequest(value: unknown): GitLabMergeRequestInfo {
  if (!isRecord(value)) {
    throw new GitportError(GITPORT_ERROR_CODE.GitLabFailed, "GitLab MR response is not an object");
  }
  const iid = numberField(value, "iid");
  const title = stringField(value, "title");
  const sourceBranch = stringField(value, "source_branch");
  const webUrl = stringField(value, "web_url");
  if (
    iid === undefined ||
    title === undefined ||
    sourceBranch === undefined ||
    webUrl === undefined
  ) {
    throw new GitportError(GITPORT_ERROR_CODE.GitLabFailed, "GitLab MR response is missing fields");
  }
  return { iid, title, sourceBranch, webUrl };
}

export function parseCurrentUser(value: unknown): GitLabCurrentUser {
  if (!isRecord(value)) {
    throw new GitportError(GITPORT_ERROR_CODE.GitLabFailed, "Current user response is not an object");
  }
  const id = numberField(value, "id");
  const username = stringField(value, "username");
  if (id === undefined || username === undefined) {
    throw new GitportError(GITPORT_ERROR_CODE.GitLabFailed, "Current user response is missing fields");
  }
  return { id, username };
}

export function parseCommit(value: unknown): SourceCommit {
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

export function parseCreatedMergeRequest(value: unknown): CreatedMergeRequest {
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

export function ensureDraftTitle(title: string): string {
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

export function nextPageFromHeaders(headers: Headers): string | undefined {
  const nextPage = headers.get("x-next-page")?.trim();
  if (nextPage !== undefined && nextPage.length > 0) {
    return nextPage;
  }
  return nextPageFromLinkHeader(headers.get("link"));
}
