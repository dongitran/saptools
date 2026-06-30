import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  JiraIssueAttachment,
  JiraIssueImageFile,
  JiraIssueImageSource,
} from "./types.js";
import {
  buildJiraAttachmentContentUrl,
  buildJiraAttachmentThumbnailUrl,
} from "./urls.js";

export const DEFAULT_JIRA_IMAGE_MAX_BYTES = 10_000_000;

export interface SaveJiraIssueImageFileOptions {
  readonly accessToken: string;
  readonly apiRoot?: string;
  readonly attachment: JiraIssueAttachment;
  readonly cloudId: string;
  readonly commentId?: string;
  readonly fetchImpl?: typeof fetch;
  readonly issueKey: string;
  readonly maxBytes?: number;
  readonly outputDir?: string;
  readonly source: JiraIssueImageSource;
}

interface FetchedImage {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export function createJiraIssueImageOutputDir(issueKey: string): string {
  const timestamp = new Date().toISOString().replaceAll(/[^0-9A-Za-z.-]/gu, "-");
  return join(
    tmpdir(),
    "saptools-jira",
    "issue-images",
    safePathSegment(issueKey),
    `${timestamp}-${randomUUID().slice(0, 8)}`,
  );
}

export async function saveJiraIssueImageFile(
  options: SaveJiraIssueImageFileOptions,
): Promise<JiraIssueImageFile | null> {
  const fetchedImage = await fetchJiraAttachmentImage(options);
  if (fetchedImage === null) {
    return null;
  }

  const outputDir = options.outputDir ?? createJiraIssueImageOutputDir(options.issueKey);
  await mkdir(outputDir, { mode: 0o700, recursive: true });
  const filePath = join(outputDir, savedImageFilename(options.attachment, fetchedImage.contentType));
  await writeFile(filePath, fetchedImage.bytes, { mode: 0o600 });

  const imageFile = {
    attachmentId: options.attachment.id,
    byteLength: fetchedImage.bytes.byteLength,
    filePath,
    fileUrl: pathToFileURL(filePath).toString(),
    filename: options.attachment.filename,
    mimeType: fetchedImage.contentType,
    source: options.source,
  };
  return options.commentId === undefined ? imageFile : { ...imageFile, commentId: options.commentId };
}

async function fetchJiraAttachmentImage(
  options: SaveJiraIssueImageFileOptions,
): Promise<FetchedImage | null> {
  const contentImage = await fetchImageEndpoint(
    buildJiraAttachmentContentUrl(options.cloudId, options.attachment.id, options.apiRoot),
    options,
  );
  return (
    contentImage ??
    (await fetchImageEndpoint(
      buildJiraAttachmentThumbnailUrl(options.cloudId, options.attachment.id, options.apiRoot),
      options,
    ))
  );
}

async function fetchImageEndpoint(
  url: string,
  options: SaveJiraIssueImageFileOptions,
): Promise<FetchedImage | null> {
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(url, jiraAttachmentRequest(options.accessToken));
    if (isRedirectResponse(response)) {
      return await fetchSignedImage(toAbsoluteRedirectUrl(response.headers.get("location"), url), options);
    }

    return response.ok ? await responseToImage(response, options) : null;
  } catch {
    return null;
  }
}

async function fetchSignedImage(
  url: string | null,
  options: SaveJiraIssueImageFileOptions,
): Promise<FetchedImage | null> {
  if (url === null) {
    return null;
  }

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(url, signedImageRequest());
    return response.ok ? await responseToImage(response, options) : null;
  } catch {
    return null;
  }
}

async function responseToImage(
  response: Response,
  options: SaveJiraIssueImageFileOptions,
): Promise<FetchedImage | null> {
  const maxBytes = options.maxBytes ?? DEFAULT_JIRA_IMAGE_MAX_BYTES;
  if (isResponseLargerThan(response, maxBytes)) {
    return null;
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    return null;
  }

  const bytes = new Uint8Array(buffer);
  const contentType = resolveImageContentType(response, bytes);
  return contentType === null ? null : { bytes, contentType };
}

function jiraAttachmentRequest(accessToken: string): RequestInit {
  return {
    headers: {
      Accept: "*/*",
      Authorization: `Bearer ${accessToken}`,
    },
    redirect: "manual",
  };
}

function signedImageRequest(): RequestInit {
  return {
    headers: {
      Accept: "image/*",
    },
  };
}

function resolveImageContentType(response: Response, bytes: Uint8Array): string | null {
  const headerContentType = normalizeContentType(response.headers.get("content-type"));
  if (isImageContentType(headerContentType)) {
    return headerContentType;
  }

  return sniffImageContentType(bytes);
}

export function isLikelyJiraImageAttachment(attachment: JiraIssueAttachment): boolean {
  return (
    imageContentTypeFromValue(attachment.mimeType) !== null ||
    imageContentTypeFromFilename(attachment.filename) !== null
  );
}

function savedImageFilename(attachment: JiraIssueAttachment, contentType: string): string {
  const extension = extname(attachment.filename) || extensionFromContentType(contentType);
  const rawName = basename(attachment.filename, extname(attachment.filename)) || "image";
  return `${safePathSegment(attachment.id)}-${safePathSegment(rawName)}${extension}`;
}

function extensionFromContentType(contentType: string): string {
  if (contentType === "image/jpeg") {
    return ".jpg";
  }

  return contentType.startsWith("image/") ? `.${contentType.slice("image/".length)}` : ".img";
}

function imageContentTypeFromValue(value: string): string | null {
  const normalized = normalizeContentType(value);
  return isImageContentType(normalized) ? normalized : null;
}

function imageContentTypeFromFilename(filename: string): string | null {
  const normalizedFilename = filename.trim().toLowerCase();
  if (normalizedFilename.endsWith(".png")) {
    return "image/png";
  }

  if (normalizedFilename.endsWith(".jpg") || normalizedFilename.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  if (normalizedFilename.endsWith(".gif")) {
    return "image/gif";
  }

  return normalizedFilename.endsWith(".webp") ? "image/webp" : null;
}

function sniffImageContentType(bytes: Uint8Array): string | null {
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }

  if (startsWithAscii(bytes, "GIF87a") || startsWithAscii(bytes, "GIF89a")) {
    return "image/gif";
  }

  return startsWithAscii(bytes, "RIFF") && asciiAt(bytes, 8, 4) === "WEBP"
    ? "image/webp"
    : null;
}

function isResponseLargerThan(response: Response, maxBytes: number): boolean {
  const contentLength = response.headers.get("content-length");
  if (contentLength === null) {
    return false;
  }

  const byteLength = Number.parseInt(contentLength, 10);
  return Number.isFinite(byteLength) && byteLength > maxBytes;
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

function normalizeContentType(value: string | null | undefined): string {
  return value?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function isImageContentType(value: string): boolean {
  return value.startsWith("image/");
}

function safePathSegment(value: string): string {
  const safe = value.trim().replaceAll(/[^0-9A-Za-z._-]+/gu, "_").replaceAll(/^_+|_+$/gu, "");
  return safe.length === 0 ? "unknown" : safe;
}

function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function startsWithAscii(bytes: Uint8Array, value: string): boolean {
  return asciiAt(bytes, 0, value.length) === value;
}

function asciiAt(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}
