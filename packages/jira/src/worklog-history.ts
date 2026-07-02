import { appendFile, mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SAPTOOLS_DIR_NAME = ".saptools";
export const JIRA_DIR_NAME = "jira";
export const WORKLOG_HISTORY_DIR_NAME = "worklog-history";

const TABLE_HEADER = "| Logged At | Started | Issue | Minutes | Hours | Comment |";
const TABLE_SEPARATOR = "| --- | --- | --- | ---: | ---: | --- |";
const MONTH_KEY_PATTERN = /^\d{6}$/u;
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MONTH_FILE_PATTERN = /^\d{6}\.md$/u;

export interface JiraWorklogHistoryEntry {
  readonly comment?: string;
  readonly issueKey: string;
  readonly loggedAt: string;
  readonly minutes: number;
  readonly started: string;
}

export interface JiraWorklogHistoryInput {
  readonly comment?: string;
  readonly issueKey: string;
  readonly loggedAt?: Date;
  readonly minutes: number;
  readonly started: string;
}

export interface WorklogHistoryOptions {
  readonly homeDir?: string;
  readonly now?: Date;
  readonly saptoolsRoot?: string;
}

export interface WorklogSummaryFilter {
  readonly day?: string;
  readonly from?: string;
  readonly issueKey?: string;
  readonly month?: string;
  readonly to?: string;
}

export interface WorklogSummaryGroup {
  readonly hours: string;
  readonly key: string;
  readonly minutes: number;
}

export interface WorklogSummary {
  readonly entries: readonly JiraWorklogHistoryEntry[];
  readonly groups: readonly WorklogSummaryGroup[];
  readonly groupBy: "day" | "issue";
  readonly hours: string;
  readonly minutes: number;
}

export function formatJiraDate(date: Date): string {
  return date.toISOString().replace("Z", "+0000");
}

export function worklogHistoryDirectory(options: WorklogHistoryOptions = {}): string {
  return join(
    options.saptoolsRoot ?? join(options.homeDir ?? homedir(), SAPTOOLS_DIR_NAME),
    JIRA_DIR_NAME,
    WORKLOG_HISTORY_DIR_NAME,
  );
}

export function worklogHistoryFilePath(monthKey: string, options: WorklogHistoryOptions = {}): string {
  assertMonthKey(monthKey);
  return join(worklogHistoryDirectory(options), `${monthKey}.md`);
}

export function monthKeyForStarted(started: string, fallback: Date = new Date()): string {
  const matched = /^(\d{4})-(\d{2})/u.exec(started);
  if (matched !== null) {
    const year = matched[1] ?? "";
    const month = matched[2] ?? "";
    return `${year}${month}`;
  }

  const parsed = new Date(started);
  return Number.isNaN(parsed.getTime()) ? monthKeyForDate(fallback) : monthKeyForDate(parsed);
}

export function dayKeyForStarted(started: string): string | null {
  const matched = /^(\d{4}-\d{2}-\d{2})/u.exec(started);
  if (matched !== null) {
    return matched[1] ?? null;
  }

  const parsed = new Date(started);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export async function appendJiraWorklogHistory(
  input: JiraWorklogHistoryInput,
  options: WorklogHistoryOptions = {},
): Promise<void> {
  if (!Number.isInteger(input.minutes) || input.minutes <= 0) {
    throw new Error("Jira worklog history minutes must be a positive integer.");
  }

  const loggedAt = (input.loggedAt ?? options.now ?? new Date()).toISOString();
  const entry: JiraWorklogHistoryEntry = {
    issueKey: input.issueKey,
    loggedAt,
    minutes: input.minutes,
    started: input.started,
    ...(input.comment === undefined ? {} : { comment: input.comment }),
  };
  const monthKey = monthKeyForStarted(input.started, input.loggedAt ?? options.now ?? new Date());
  const directory = worklogHistoryDirectory(options);
  const path = worklogHistoryFilePath(monthKey, options);
  await mkdir(directory, { mode: 0o700, recursive: true });
  await ensureHistoryFile(path, monthKey);
  await appendFile(path, `${formatHistoryRow(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function readJiraWorklogHistory(
  filter: WorklogSummaryFilter = {},
  options: WorklogHistoryOptions = {},
): Promise<JiraWorklogHistoryEntry[]> {
  const monthKeys = await resolveMonthKeys(filter, options);
  const lists = await Promise.all(
    monthKeys.map(async (monthKey) => await readMonthHistory(monthKey, options)),
  );
  return lists.flat().filter((entry) => matchesFilter(entry, filter));
}

export async function summarizeJiraWorklogHistory(
  filter: WorklogSummaryFilter = {},
  groupBy: "day" | "issue" = "issue",
  options: WorklogHistoryOptions = {},
): Promise<WorklogSummary> {
  const entries = await readJiraWorklogHistory(filter, options);
  const minutes = entries.reduce((total, entry) => total + entry.minutes, 0);
  return {
    entries,
    groupBy,
    groups: groupEntries(entries, groupBy),
    hours: formatHours(minutes),
    minutes,
  };
}

export function formatHistoryRow(entry: JiraWorklogHistoryEntry): string {
  return `| ${escapeMarkdownCell(entry.loggedAt)} | ${escapeMarkdownCell(entry.started)} | ${escapeMarkdownCell(entry.issueKey)} | ${entry.minutes.toString()} | ${formatHours(entry.minutes)} | ${escapeMarkdownCell(entry.comment ?? "")} |`;
}

export function parseHistoryMarkdown(markdown: string): JiraWorklogHistoryEntry[] {
  return markdown
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && !line.startsWith(TABLE_HEADER) && !line.startsWith("| ---"))
    .map(parseHistoryRow)
    .filter((entry): entry is JiraWorklogHistoryEntry => entry !== null);
}

export function escapeMarkdownCell(value: string): string {
  return value.trim().replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll(/\r?\n/gu, "<br>");
}

export function formatHours(minutes: number): string {
  return (minutes / 60).toFixed(2);
}

async function ensureHistoryFile(path: string, monthKey: string): Promise<void> {
  try {
    const fileStat = await stat(path);
    if (fileStat.size > 0) {
      return;
    }
  } catch (error: unknown) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  const handle = await open(path, "a", 0o600);
  try {
    const fileStat = await handle.stat();
    if (fileStat.size === 0) {
      await handle.writeFile(`# Jira Worklog History ${monthKey}\n\n${TABLE_HEADER}\n${TABLE_SEPARATOR}\n`, "utf8");
    }
  } finally {
    await handle.close();
  }
}

async function readMonthHistory(
  monthKey: string,
  options: WorklogHistoryOptions,
): Promise<JiraWorklogHistoryEntry[]> {
  try {
    return parseHistoryMarkdown(await readFile(worklogHistoryFilePath(monthKey, options), "utf8"));
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

async function resolveMonthKeys(
  filter: WorklogSummaryFilter,
  options: WorklogHistoryOptions,
): Promise<string[]> {
  if (filter.month !== undefined) {
    assertMonthKey(filter.month);
    return [filter.month];
  }
  if (filter.day !== undefined) {
    assertDayKey(filter.day, "--day <YYYY-MM-DD>");
    return [filter.day.slice(0, 7).replace("-", "")];
  }
  const rangeKeys = monthKeysForRange(filter.from, filter.to);
  if (rangeKeys.length > 0) {
    return rangeKeys;
  }

  try {
    const files = await readdir(worklogHistoryDirectory(options));
    return files.filter((file) => MONTH_FILE_PATTERN.test(file)).map((file) => file.slice(0, 6)).sort();
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

function monthKeysForRange(from: string | undefined, to: string | undefined): string[] {
  if (from === undefined && to === undefined) {
    return [];
  }
  const start = parseDayKey(from ?? to ?? "", "--from <YYYY-MM-DD>");
  const end = parseDayKey(to ?? from ?? "", "--to <YYYY-MM-DD>");
  if (start.getTime() > end.getTime()) {
    throw new Error("--from must be earlier than or equal to --to");
  }
  const keys: string[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const finalMonth = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1);
  while (cursor.getTime() <= finalMonth) {
    keys.push(monthKeyForDate(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}

function matchesFilter(entry: JiraWorklogHistoryEntry, filter: WorklogSummaryFilter): boolean {
  const day = dayKeyForStarted(entry.started);
  if (filter.issueKey !== undefined && entry.issueKey !== filter.issueKey) {
    return false;
  }
  if (filter.day !== undefined && day !== filter.day) {
    return false;
  }
  if (filter.from !== undefined && (day === null || day < filter.from)) {
    return false;
  }
  if (filter.to !== undefined && (day === null || day > filter.to)) {
    return false;
  }
  return true;
}

function groupEntries(
  entries: readonly JiraWorklogHistoryEntry[],
  groupBy: "day" | "issue",
): WorklogSummaryGroup[] {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    const key = groupBy === "day" ? dayKeyForStarted(entry.started) ?? "unknown" : entry.issueKey;
    totals.set(key, (totals.get(key) ?? 0) + entry.minutes);
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, minutes]) => ({ hours: formatHours(minutes), key, minutes }));
}

function parseHistoryRow(line: string): JiraWorklogHistoryEntry | null {
  const cells = splitMarkdownRow(line);
  if (cells.length !== 6) {
    return null;
  }
  const minutes = Number(cells[3]);
  if (!Number.isSafeInteger(minutes) || minutes <= 0) {
    return null;
  }
  return {
    loggedAt: unescapeMarkdownCell(cells[0] ?? ""),
    started: unescapeMarkdownCell(cells[1] ?? ""),
    issueKey: unescapeMarkdownCell(cells[2] ?? ""),
    minutes,
    ...(cells[5] === undefined || cells[5].length === 0 ? {} : { comment: unescapeMarkdownCell(cells[5]) }),
  };
}

function splitMarkdownRow(line: string): string[] {
  const trimmed = line.replace(/^\|/u, "").replace(/\|$/u, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function unescapeMarkdownCell(value: string): string {
  return value.replaceAll("<br>", "\n");
}

function monthKeyForDate(date: Date): string {
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${date.getUTCFullYear().toString()}${month}`;
}

function assertMonthKey(monthKey: string): void {
  if (!MONTH_KEY_PATTERN.test(monthKey)) {
    throw new Error("--month <YYYYMM> must use YYYYMM format");
  }
}

function assertDayKey(day: string, label: string): void {
  parseDayKey(day, label);
}

function parseDayKey(day: string, label: string): Date {
  if (!DAY_KEY_PATTERN.test(day)) {
    throw new Error(`${label} must use YYYY-MM-DD format`);
  }
  return new Date(`${day}T00:00:00.000Z`);
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
