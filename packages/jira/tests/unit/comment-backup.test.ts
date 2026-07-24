import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  jiraCommentBackupPath,
  writeJiraCommentBackup,
} from "../../src/comment-backup.js";
import type { JiraIssueCommentDetail } from "../../src/types.js";

const tempDirs: string[] = [];
const comment: JiraIssueCommentDetail = {
  authorDisplayName: "Synthetic Reviewer",
  body: {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text: "Recover me" }] }],
  },
  created: "2026-07-24T08:00:00.000+0000",
  id: "100/98",
  updated: "2026-07-24T09:00:00.000+0000",
};

afterEach(async () => {
  await Promise.all(tempDirs.map(async (path) => {
    await rm(path, { force: true, recursive: true });
  }));
  tempDirs.length = 0;
});

describe("Jira comment backups", () => {
  it("writes the full comment under the private cloud-scoped cache tree", async () => {
    const homeDir = await createTempDir();
    const backupPath = await writeJiraCommentBackup(
      "cloud/../1",
      "OPS/../123",
      comment,
      { homeDir },
    );

    expect(backupPath).toBe(join(
      homeDir,
      ".saptools",
      "jira",
      "clouds",
      "cloud_.._1",
      "comments",
      "OPS_.._123",
      "100_98.json",
    ));
    expect(JSON.parse(await readFile(backupPath, "utf8"))).toEqual(comment);
    if (process.platform !== "win32") {
      expect((await stat(dirname(backupPath))).mode & 0o777).toBe(0o700);
      expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects empty or traversal-only path segments", async () => {
    const homeDir = await createTempDir();

    expect(() => jiraCommentBackupPath("cloud-1", "..", "10098", { homeDir }))
      .toThrow("Jira issue key cannot be used as a local backup path segment.");
    expect(() => jiraCommentBackupPath("..", "OPS-123", "10098", { homeDir }))
      .toThrow("Jira cloud ID cannot be used as a local backup path segment.");
    expect(() => jiraCommentBackupPath("cloud-1", "OPS-123", ".", { homeDir }))
      .toThrow("Jira comment ID cannot be used as a local backup path segment.");
    expect(() => jiraCommentBackupPath("cloud-1", " ", "10098", { homeDir }))
      .toThrow("Jira issue key cannot be used as a local backup path segment.");
  });

  it("fails the write when the issue backup directory cannot be created", async () => {
    const homeDir = await createTempDir();
    const backupPath = jiraCommentBackupPath("cloud-1", "OPS-BLOCKED", comment.id, { homeDir });
    const issueDirectory = dirname(backupPath);
    await mkdir(dirname(issueDirectory), { recursive: true });
    await writeFile(issueDirectory, "blocking file", "utf8");

    await expect(writeJiraCommentBackup(
      "cloud-1",
      "OPS-BLOCKED",
      comment,
      { homeDir },
    )).rejects.toBeInstanceOf(Error);
  });

  it("removes a temporary file when the final rename fails", async () => {
    const homeDir = await createTempDir();
    const backupPath = jiraCommentBackupPath("cloud-1", "OPS-RENAME", comment.id, { homeDir });
    await mkdir(backupPath, { recursive: true });

    await expect(writeJiraCommentBackup(
      "cloud-1",
      "OPS-RENAME",
      comment,
      { homeDir },
    )).rejects.toBeInstanceOf(Error);
    expect((await readdir(dirname(backupPath))).filter((name) => name.endsWith(".tmp")))
      .toEqual([]);
  });
});

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "saptools-jira-comment-backup-"));
  tempDirs.push(path);
  return path;
}
