import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DbUserRole, StatementKind } from "./types.js";

const SAPTOOLS_DIR_NAME = ".saptools";
const CF_HANA_DIR_NAME = "cf-hana";
const HISTORIES_DIR_NAME = "histories";
const HISTORY_RETENTION_DAYS = 5;
const HISTORY_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export type SqlHistoryOperation = "query" | "execute";

export interface SqlHistoryEntryInput {
  readonly version: string;
  readonly operation: SqlHistoryOperation;
  readonly selector: string;
  readonly appName: string;
  readonly schema: string;
  readonly role: DbUserRole;
  readonly statement: StatementKind;
  readonly sql: string;
  readonly paramCount: number;
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly elapsedMs: number;
}

export interface SqlHistoryEntry extends SqlHistoryEntryInput {
  readonly at: string;
}

export interface SqlHistoryWriteOptions {
  readonly now?: Date;
  readonly saptoolsRoot?: string;
}

function defaultSaptoolsRoot(): string {
  return join(homedir(), SAPTOOLS_DIR_NAME);
}

function padDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}

function dateKey(date: Date): string {
  return [
    date.getFullYear().toString(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
  ].join("-");
}

function retentionCutoffKey(now: Date): string {
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - HISTORY_RETENTION_DAYS);
  return dateKey(cutoff);
}

function resolveSaptoolsRoot(root: string | undefined): string {
  return root ?? defaultSaptoolsRoot();
}

export function cfHanaHistoryDirectory(saptoolsRoot?: string): string {
  return join(resolveSaptoolsRoot(saptoolsRoot), CF_HANA_DIR_NAME, HISTORIES_DIR_NAME);
}

export function sqlHistoryFilePath(now: Date = new Date(), saptoolsRoot?: string): string {
  return join(cfHanaHistoryDirectory(saptoolsRoot), `${dateKey(now)}.jsonl`);
}

async function pruneSqlHistory(now: Date, saptoolsRoot?: string): Promise<void> {
  const historyDir = cfHanaHistoryDirectory(saptoolsRoot);
  let files: readonly string[];
  try {
    files = await readdir(historyDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  const cutoffKey = retentionCutoffKey(now);
  await Promise.all(
    files
      .filter((file) => HISTORY_FILE_PATTERN.test(file))
      .filter((file) => file.slice(0, 10) < cutoffKey)
      .map(async (file) => {
        await rm(join(historyDir, file), { force: true });
      }),
  );
}

export async function appendSqlHistory(
  input: SqlHistoryEntryInput,
  options: SqlHistoryWriteOptions = {},
): Promise<SqlHistoryEntry> {
  const now = options.now ?? new Date();
  const historyDir = cfHanaHistoryDirectory(options.saptoolsRoot);
  const entry: SqlHistoryEntry = {
    at: now.toISOString(),
    ...input,
  };

  await mkdir(historyDir, { recursive: true, mode: 0o700 });
  await appendFile(sqlHistoryFilePath(now, options.saptoolsRoot), `${JSON.stringify(entry)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await pruneSqlHistory(now, options.saptoolsRoot);
  } catch {
    // Retention is best-effort; the SQL history entry was already recorded.
  }

  return entry;
}
