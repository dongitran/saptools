import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendJiraWorklogHistory,
  escapeMarkdownCell,
  formatHistoryRow,
  monthKeyForStarted,
  parseHistoryMarkdown,
  readJiraWorklogHistory,
  summarizeJiraWorklogHistory,
  worklogHistoryDirectory,
  worklogHistoryFilePath,
} from "../../src/worklog-history.js";

let rootDir = "";

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "jira-worklog-history-"));
});

afterEach(async () => {
  await rm(rootDir, { force: true, recursive: true });
});

describe("Jira worklog history", () => {
  it("resolves monthly history paths under the saptools jira worklog folder", () => {
    expect(worklogHistoryDirectory({ homeDir: rootDir })).toBe(
      join(rootDir, ".saptools", "jira", "worklog-history"),
    );
    expect(worklogHistoryFilePath("202607", { homeDir: rootDir })).toBe(
      join(rootDir, ".saptools", "jira", "worklog-history", "202607.md"),
    );
  });

  it("derives month keys from Jira started timestamps and falls back for unparseable text", () => {
    expect(monthKeyForStarted("2026-05-01T08:20:00.000+0000")).toBe("202605");
    expect(monthKeyForStarted("not-a-date", new Date("2026-07-02T00:00:00.000Z"))).toBe("202607");
  });

  it("escapes Markdown cells and parses generated rows back into entries", () => {
    const entry = {
      comment: "Reviewed | rollout\nlogs",
      issueKey: "OPS-123",
      loggedAt: "2026-07-02T06:20:15.123Z",
      minutes: 30,
      started: "2026-07-02T06:20:14.000+0000",
    };

    expect(escapeMarkdownCell(" Reviewed | rollout\r\nlogs ")).toBe("Reviewed \\| rollout<br>logs");
    expect(parseHistoryMarkdown(`# Jira Worklog History 202607\n\n| Logged At | Started | Issue | Minutes | Hours | Comment |\n| --- | --- | --- | ---: | ---: | --- |\n${formatHistoryRow(entry)}\n`)).toEqual([
      { ...entry, comment: "Reviewed | rollout\nlogs" },
    ]);
  });

  it("creates private monthly files with one header and appends rows", async () => {
    const now = new Date("2026-07-02T06:20:15.123Z");
    await appendJiraWorklogHistory(
      {
        comment: "First",
        issueKey: "OPS-123",
        minutes: 30,
        started: "2026-07-02T06:20:14.000+0000",
      },
      { homeDir: rootDir, now },
    );
    await appendJiraWorklogHistory(
      {
        issueKey: "OPS-456",
        minutes: 45,
        started: "2026-07-03T06:20:14.000+0000",
      },
      { homeDir: rootDir, now },
    );

    const path = worklogHistoryFilePath("202607", { homeDir: rootDir });
    const raw = await readFile(path, "utf8");
    expect(raw.match(/Jira Worklog History/gu)).toHaveLength(1);
    expect(parseHistoryMarkdown(raw)).toHaveLength(2);

    if (process.platform !== "win32") {
      expect((await stat(worklogHistoryDirectory({ homeDir: rootDir }))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("summarizes totals by day, issue, month, and date range", async () => {
    await appendJiraWorklogHistory({ issueKey: "OPS-123", minutes: 30, started: "2026-07-02T01:00:00.000+0000" }, { homeDir: rootDir, now: new Date("2026-07-02T02:00:00Z") });
    await appendJiraWorklogHistory({ issueKey: "OPS-123", minutes: 15, started: "2026-07-03T01:00:00.000+0000" }, { homeDir: rootDir, now: new Date("2026-07-03T02:00:00Z") });
    await appendJiraWorklogHistory({ issueKey: "OPS-456", minutes: 60, started: "2026-08-02T01:00:00.000+0000" }, { homeDir: rootDir, now: new Date("2026-08-02T02:00:00Z") });

    await expect(summarizeJiraWorklogHistory({ day: "2026-07-02" }, "issue", { homeDir: rootDir })).resolves.toMatchObject({
      groups: [{ hours: "0.50", key: "OPS-123", minutes: 30 }],
      minutes: 30,
    });
    await expect(summarizeJiraWorklogHistory({ issueKey: "OPS-123", month: "202607" }, "day", { homeDir: rootDir })).resolves.toMatchObject({
      groups: [
        { key: "2026-07-02", minutes: 30 },
        { key: "2026-07-03", minutes: 15 },
      ],
      minutes: 45,
    });
    await expect(readJiraWorklogHistory({ from: "2026-07-03", to: "2026-08-01" }, { homeDir: rootDir })).resolves.toEqual([
      expect.objectContaining({ issueKey: "OPS-123", minutes: 15 }),
    ]);
  });

  it("lists all monthly files when no month filter is supplied", async () => {
    await appendJiraWorklogHistory({ issueKey: "OPS-123", minutes: 30, started: "2026-07-02T01:00:00.000+0000" }, { homeDir: rootDir, now: new Date("2026-07-02T02:00:00Z") });
    await appendJiraWorklogHistory({ issueKey: "OPS-456", minutes: 60, started: "2026-08-02T01:00:00.000+0000" }, { homeDir: rootDir, now: new Date("2026-08-02T02:00:00Z") });

    await expect(summarizeJiraWorklogHistory({}, "issue", { homeDir: rootDir })).resolves.toMatchObject({
      groups: [
        { key: "OPS-123", minutes: 30 },
        { key: "OPS-456", minutes: 60 },
      ],
      minutes: 90,
    });
  });

  it("ignores malformed generated-table lines and reports unknown days for unparseable starts", async () => {
    const markdown = [
      "| Logged At | Started | Issue | Minutes | Hours | Comment |",
      "| --- | --- | --- | ---: | ---: | --- |",
      "| too | few | cells |",
      "| 2026-07-02T00:00:00.000Z | not-a-date | OPS-123 | nope | 0.00 | bad |",
      "| 2026-07-02T00:00:00.000Z | not-a-date | OPS-123 | 15 | 0.25 | |",
    ].join("\n");

    expect(parseHistoryMarkdown(markdown)).toEqual([
      { issueKey: "OPS-123", loggedAt: "2026-07-02T00:00:00.000Z", minutes: 15, started: "not-a-date" },
    ]);
  });

  it("validates summary date and month filters", async () => {
    await expect(summarizeJiraWorklogHistory({ month: "2026-07" }, "issue", { homeDir: rootDir })).rejects.toThrow("YYYYMM");
    await expect(summarizeJiraWorklogHistory({ day: "20260702" }, "issue", { homeDir: rootDir })).rejects.toThrow("YYYY-MM-DD");
    await expect(summarizeJiraWorklogHistory({ from: "2026-07-03", to: "2026-07-02" }, "issue", { homeDir: rootDir })).rejects.toThrow("--from");
    await expect(appendJiraWorklogHistory({ issueKey: "OPS-123", minutes: 0, started: "2026-07-02T01:00:00.000+0000" }, { homeDir: rootDir })).rejects.toThrow("positive integer");
  });

  it("returns empty summaries for missing history files", async () => {
    await expect(summarizeJiraWorklogHistory({ month: "202607" }, "issue", { homeDir: rootDir })).resolves.toMatchObject({
      entries: [],
      groups: [],
      minutes: 0,
    });
  });

  it("surfaces append failures for the CLI to warn without retrying Jira", async () => {
    const blockedRoot = join(rootDir, ".saptools-file");
    await writeFile(blockedRoot, "not a directory", "utf8");
    await expect(
      appendJiraWorklogHistory(
        { issueKey: "OPS-123", minutes: 30, started: "2026-07-02T01:00:00.000+0000" },
        { saptoolsRoot: blockedRoot },
      ),
    ).rejects.toThrow();
  });
});
