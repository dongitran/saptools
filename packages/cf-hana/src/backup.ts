import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { WriteBackupOperation, WriteBackupPlan } from "./001-backup-planner.js";
import { MAX_RESULT_STORE_BYTES } from "./config.js";
import { BackupRequiredError } from "./errors.js";
import { formatCsv } from "./format.js";
import type { QueryResult } from "./types.js";

export { buildWriteBackupPlan } from "./001-backup-planner.js";
export type { WriteBackupOperation, WriteBackupPlan };

const SAPTOOLS_DIR_NAME = ".saptools";
const CF_HANA_DIR_NAME = "cf-hana";
const BACKUPS_DIR_NAME = "backups";

export interface SqlBackupWriteInput {
  readonly operation: WriteBackupOperation;
  readonly statementSql: string;
  readonly result: QueryResult;
  readonly selector?: string;
}

export interface SqlBackupWriteOptions {
  readonly now?: Date;
  readonly saptoolsRoot?: string;
  readonly maxBytes?: number;
}

export interface SqlBackupRecord {
  readonly directory: string;
  readonly statementPath: string;
  readonly backupPath: string;
  readonly metadataPath: string;
  readonly rowCount: number;
}

function defaultSaptoolsRoot(): string {
  return join(homedir(), SAPTOOLS_DIR_NAME);
}

function backupTimestamp(now: Date): string {
  return now.toISOString().replace(/:/g, "").replace(".", "");
}

function backupMonth(now: Date): string {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}${month}`;
}

function sanitizePathPart(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  const normalized = trimmed
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized.length > 0 ? normalized : "unknown-target";
}

function backupBaseName(input: SqlBackupWriteInput, now: Date): string {
  return [sanitizePathPart(input.selector), input.operation, backupTimestamp(now)].join("-");
}

export function cfHanaBackupRoot(saptoolsRoot?: string): string {
  return join(saptoolsRoot ?? defaultSaptoolsRoot(), CF_HANA_DIR_NAME, BACKUPS_DIR_NAME);
}

export async function writeSqlBackup(
  input: SqlBackupWriteInput,
  options: SqlBackupWriteOptions = {},
): Promise<SqlBackupRecord> {
  const now = options.now ?? new Date();
  const directory = join(cfHanaBackupRoot(options.saptoolsRoot), backupMonth(now));
  const baseName = backupBaseName(input, now);
  const statementPath = join(directory, `${baseName}.statement.sql`);
  const backupPath = join(directory, `${baseName}.sql`);
  const metadataPath = join(directory, `${baseName}.json`);
  const metadata = {
    selector: input.selector ?? null,
    operation: input.operation,
    statementPath,
    backupPath,
    rowCount: input.result.rowCount,
    createdAt: now.toISOString(),
  };
  const csv = formatCsv(input.result);
  if (Buffer.byteLength(csv) > (options.maxBytes ?? MAX_RESULT_STORE_BYTES)) {
    throw new BackupRequiredError(
      "Write backup exceeds the storage limit; the write was refused",
    );
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(statementPath, `${input.statementSql}\n`, { encoding: "utf8", mode: 0o600 }),
    writeFile(backupPath, csv, { encoding: "utf8", mode: 0o600 }),
    writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    }),
  ]);

  return {
    directory,
    statementPath,
    backupPath,
    metadataPath,
    rowCount: input.result.rowCount,
  };
}
