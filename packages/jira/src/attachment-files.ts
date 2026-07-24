import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { JiraIssueAttachment } from "./types.js";
import { buildJiraAttachmentContentUrl } from "./urls.js";

export const DEFAULT_JIRA_ATTACHMENT_MAX_BYTES = 10_000_000;

export interface FetchJiraAttachmentContentOptions {
  readonly accessToken: string;
  readonly apiRoot?: string;
  readonly attachment: JiraIssueAttachment;
  readonly cloudId: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxBytes?: number;
}

export interface SaveJiraIssueAttachmentFileOptions extends FetchJiraAttachmentContentOptions {
  readonly issueKey: string;
  readonly outputDir?: string;
}

export type JiraAttachmentContentResult =
  | { readonly bytes: Uint8Array; readonly error: null }
  | { readonly bytes: null; readonly error: string };

export type JiraAttachmentFileResult =
  | { readonly error: null; readonly fileUrl: string; readonly localPath: string }
  | { readonly error: string; readonly fileUrl: null; readonly localPath: null };

export function createJiraIssueAttachmentOutputDir(issueKey: string): string {
  const timestamp = new Date().toISOString().replaceAll(/[^0-9A-Za-z.-]/gu, "-");
  return join(
    tmpdir(),
    "saptools-jira",
    "issue-attachments",
    safePathSegment(issueKey),
    `${timestamp}-${randomUUID().slice(0, 8)}`,
  );
}

export async function fetchJiraAttachmentContent(
  options: FetchJiraAttachmentContentOptions,
): Promise<JiraAttachmentContentResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_JIRA_ATTACHMENT_MAX_BYTES;
  if (options.attachment.size > maxBytes) {
    return downloadFailure(`Attachment exceeds the ${maxBytes.toString()} byte download limit.`);
  }

  try {
    const url = buildJiraAttachmentContentUrl(
      options.cloudId,
      options.attachment.id,
      options.apiRoot,
    );
    const response = await (options.fetchImpl ?? fetch)(
      url,
      jiraAttachmentRequest(options.accessToken, maxBytes),
    );
    const contentResponse = isRedirectResponse(response)
      ? await fetchSignedAttachment(response.headers.get("location"), url, options, maxBytes)
      : response;
    return contentResponse === null
      ? downloadFailure("Attachment download redirect was not valid.")
      : await responseToAttachmentContent(contentResponse, maxBytes);
  } catch {
    return downloadFailure("Attachment download failed.");
  }
}

export async function saveJiraIssueAttachmentFile(
  options: SaveJiraIssueAttachmentFileOptions,
): Promise<JiraAttachmentFileResult> {
  const content = await fetchJiraAttachmentContent(options);
  if (content.bytes === null) {
    return fileFailure(content.error);
  }

  try {
    const outputDir = options.outputDir ?? createJiraIssueAttachmentOutputDir(options.issueKey);
    await mkdir(outputDir, { mode: 0o700, recursive: true });
    const localPath = join(outputDir, savedAttachmentFilename(options.attachment));
    await writeFile(localPath, content.bytes, { mode: 0o600 });
    return {
      error: null,
      fileUrl: pathToFileURL(localPath).toString(),
      localPath,
    };
  } catch {
    return fileFailure("Attachment could not be saved locally.");
  }
}

async function fetchSignedAttachment(
  location: string | null,
  baseUrl: string,
  options: FetchJiraAttachmentContentOptions,
  maxBytes: number,
): Promise<Response | null> {
  const url = toAbsoluteRedirectUrl(location, baseUrl);
  return url === null
    ? null
    : await (options.fetchImpl ?? fetch)(url, signedAttachmentRequest(maxBytes));
}

async function responseToAttachmentContent(
  response: Response,
  maxBytes: number,
): Promise<JiraAttachmentContentResult> {
  if (!response.ok) {
    return downloadFailure(`Attachment download returned HTTP ${response.status.toString()}.`);
  }
  if (responseIsLargerThan(response, maxBytes)) {
    await cancelResponseBody(response);
    return downloadFailure(`Attachment response exceeded the ${maxBytes.toString()} byte download limit.`);
  }

  const bytes = await readBoundedResponseBody(response, maxBytes);
  if (bytes === null) {
    return downloadFailure(`Attachment response exceeded the ${maxBytes.toString()} byte download limit.`);
  }
  return bytes.byteLength === 0
    ? downloadFailure("Attachment download returned an empty body.")
    : { bytes, error: null };
}

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (response.body === null) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const result: unknown = await reader.read();
    if (!isResponseBodyChunk(result)) {
      await reader.cancel();
      return null;
    }
    if (result.done) {
      return combineChunks(chunks, totalBytes);
    }
    totalBytes += result.value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(result.value);
  }
}

function isResponseBodyChunk(
  value: unknown,
): value is { readonly done: false; readonly value: Uint8Array } | { readonly done: true } {
  if (typeof value !== "object" || value === null || !("done" in value)) {
    return false;
  }
  if (value.done === true) {
    return true;
  }
  return value.done === false && "value" in value && value.value instanceof Uint8Array;
}

function combineChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function jiraAttachmentRequest(accessToken: string, maxBytes: number): RequestInit {
  return {
    headers: {
      Accept: "*/*",
      Authorization: `Bearer ${accessToken}`,
      Range: `bytes=0-${maxBytes.toString()}`,
    },
    redirect: "manual",
  };
}

function signedAttachmentRequest(maxBytes: number): RequestInit {
  return {
    headers: {
      Accept: "*/*",
      Range: `bytes=0-${maxBytes.toString()}`,
    },
  };
}

function responseIsLargerThan(response: Response, maxBytes: number): boolean {
  const contentLength = response.headers.get("content-length");
  if (contentLength === null) {
    return false;
  }
  const byteLength = Number.parseInt(contentLength, 10);
  return Number.isFinite(byteLength) && byteLength > maxBytes;
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body !== null) {
    await response.body.cancel();
  }
}

function isRedirectResponse(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

function toAbsoluteRedirectUrl(location: string | null, baseUrl: string): string | null {
  if (location === null || location.trim().length === 0) {
    return null;
  }
  try {
    return new URL(location, baseUrl).toString();
  } catch {
    return null;
  }
}

function savedAttachmentFilename(attachment: JiraIssueAttachment): string {
  return `${safePathSegment(attachment.id)}-${safePathSegment(basename(attachment.filename))}`;
}

function safePathSegment(value: string): string {
  const safe = value.trim().replaceAll(/[^0-9A-Za-z._-]+/gu, "_").replaceAll(/^_+|_+$/gu, "");
  return safe.length === 0 ? "unknown" : safe;
}

function downloadFailure(error: string): JiraAttachmentContentResult {
  return { bytes: null, error };
}

function fileFailure(error: string): JiraAttachmentFileResult {
  return { error, fileUrl: null, localPath: null };
}
