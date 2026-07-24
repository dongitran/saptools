import { chmod, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  jiraCloudDataDirectory,
  safeCloudIdSegment,
  type CustomFieldStoreOptions,
} from "./custom-field-store.js";
import type { JiraIssueCommentDetail } from "./types.js";

const COMMENTS_DIRECTORY_NAME = "comments";

export type JiraCommentBackupOptions = CustomFieldStoreOptions;

export function jiraCommentBackupPath(
  cloudId: string,
  issueKey: string,
  commentId: string,
  options: JiraCommentBackupOptions = {},
): string {
  const cloudSegment = safeCommentPathSegment(cloudId, "Jira cloud ID");
  const issueSegment = safeCommentPathSegment(issueKey, "Jira issue key");
  const commentSegment = safeCommentPathSegment(commentId, "Jira comment ID");
  return resolve(
    jiraCloudDataDirectory(cloudSegment, options),
    COMMENTS_DIRECTORY_NAME,
    issueSegment,
    `${commentSegment}.json`,
  );
}

export async function writeJiraCommentBackup(
  cloudId: string,
  issueKey: string,
  comment: JiraIssueCommentDetail,
  options: JiraCommentBackupOptions = {},
): Promise<string> {
  const path = jiraCommentBackupPath(cloudId, issueKey, comment.id, options);
  await writeDurablePrivateJson(path, comment);
  return path;
}

function safeCommentPathSegment(value: string, label: string): string {
  const trimmed = value.trim();
  const segment = safeCloudIdSegment(trimmed);
  if (trimmed.length === 0 || segment === "." || segment === "..") {
    throw new Error(`${label} cannot be used as a local backup path segment.`);
  }
  return segment;
}

async function writeDurablePrivateJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid.toString()}.${Date.now().toString()}.tmp`;
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
  let handle: FileHandle | undefined = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    await syncBackupFile(path);
  } catch (error: unknown) {
    await handle?.close().catch((): undefined => undefined);
    await rm(temporaryPath, { force: true }).catch((): undefined => undefined);
    throw error;
  }
}

async function syncBackupFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
