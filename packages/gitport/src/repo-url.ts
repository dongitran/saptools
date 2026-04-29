import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { GITPORT_ERROR_CODE, GitportError } from "./errors.js";

export type RepoRefKind = "http" | "ssh" | "file" | "local";

export interface RepoRef {
  readonly original: string;
  readonly projectPath: string;
  readonly name: string;
  readonly kind: RepoRefKind;
  readonly defaultApiBase?: string | undefined;
}

export interface SourceMergeRequestRef {
  readonly sourceRepo: RepoRef;
  readonly sourceMergeRequestIid: number;
  readonly sourceMergeRequestUrl: string;
}

const MERGE_REQUEST_PATH_MARKER = "/-/merge_requests/";

function stripGitSuffix(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function repoNameFromPath(value: string): string {
  const withoutTrailingSlash = value.replace(/\/+$/, "");
  return stripGitSuffix(basename(withoutTrailingSlash));
}

function parseHttpRepoRef(input: string): RepoRef | undefined {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return undefined;
    }
    const projectPath = stripGitSuffix(decodeURIComponent(url.pathname.replace(/^\/+/, "")));
    if (projectPath.length === 0) {
      throw new GitportError(GITPORT_ERROR_CODE.InvalidInput, `Invalid repo URL: ${input}`);
    }
    return {
      original: input,
      projectPath,
      name: repoNameFromPath(projectPath),
      kind: "http",
      defaultApiBase: `${url.origin}/api/v4`,
    };
  } catch (error: unknown) {
    if (error instanceof GitportError) {
      throw error;
    }
    return undefined;
  }
}

function parseFileRepoRef(input: string): RepoRef | undefined {
  try {
    const url = new URL(input);
    if (url.protocol !== "file:") {
      return undefined;
    }
    const path = fileURLToPath(url);
    const name = repoNameFromPath(path);
    return { original: input, projectPath: name, name, kind: "file" };
  } catch {
    return undefined;
  }
}

function parseSshRepoRef(input: string): RepoRef | undefined {
  if (input.includes("://")) {
    return undefined;
  }
  const match = /^(?:[^@:\s]+@)?([^:\s]+):(.+)$/.exec(input);
  const host = match?.[1];
  const rawPath = match?.[2];
  if (host === undefined || rawPath === undefined || rawPath.length === 0) {
    return undefined;
  }
  const projectPath = stripGitSuffix(rawPath.replace(/^\/+/, ""));
  return {
    original: input,
    projectPath,
    name: repoNameFromPath(projectPath),
    kind: "ssh",
    defaultApiBase: `https://${host}/api/v4`,
  };
}

function hasUrlScheme(input: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(input);
}

function normalizeMergeRequestInput(input: string): string {
  try {
    const url = new URL(input);
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return input.replace(/\/+$/, "");
  }
}

function parseMergeRequestIid(raw: string, input: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new GitportError(
      GITPORT_ERROR_CODE.InvalidInput,
      `Source repo must be a GitLab merge request URL: ${input}`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new GitportError(
      GITPORT_ERROR_CODE.InvalidInput,
      `Source repo must be a GitLab merge request URL: ${input}`,
    );
  }
  return value;
}

export function parseRepoRef(input: string): RepoRef {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new GitportError(GITPORT_ERROR_CODE.InvalidInput, "Repo URL cannot be empty");
  }

  const parsed =
    parseHttpRepoRef(trimmed) ?? parseFileRepoRef(trimmed) ?? parseSshRepoRef(trimmed);
  if (parsed !== undefined) {
    return parsed;
  }
  if (hasUrlScheme(trimmed)) {
    throw new GitportError(GITPORT_ERROR_CODE.InvalidInput, `Unsupported repo URL scheme: ${input}`);
  }

  const name = repoNameFromPath(trimmed);
  if (name.length === 0) {
    throw new GitportError(GITPORT_ERROR_CODE.InvalidInput, `Invalid repo path: ${input}`);
  }
  return { original: input, projectPath: name, name, kind: "local" };
}

export function parseSourceMergeRequestRef(input: string): SourceMergeRequestRef {
  const trimmed = input.trim();
  const normalized = normalizeMergeRequestInput(trimmed);
  const markerIndex = normalized.indexOf(MERGE_REQUEST_PATH_MARKER);
  if (trimmed.length === 0 || markerIndex < 0) {
    throw new GitportError(
      GITPORT_ERROR_CODE.InvalidInput,
      `Source repo must be a GitLab merge request URL: ${input}`,
    );
  }
  const repoInput = normalized.slice(0, markerIndex);
  const iidRaw = normalized
    .slice(markerIndex + MERGE_REQUEST_PATH_MARKER.length)
    .split("/")[0] ?? "";
  const sourceMergeRequestUrl = `${repoInput}${MERGE_REQUEST_PATH_MARKER}${iidRaw}`;
  return {
    sourceRepo: parseRepoRef(repoInput),
    sourceMergeRequestIid: parseMergeRequestIid(iidRaw, input),
    sourceMergeRequestUrl,
  };
}

export function encodeProjectPath(projectPath: string): string {
  return encodeURIComponent(projectPath);
}

export function buildAuthenticatedRemote(remote: string, token: string): string {
  try {
    const url = new URL(remote);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return remote;
    }
    url.username = "oauth2";
    url.password = token;
    return url.toString();
  } catch {
    return remote;
  }
}
