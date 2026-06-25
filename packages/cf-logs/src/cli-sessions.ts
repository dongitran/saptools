import { cfLogsSessionsDir } from "./paths.js";
import {
  clearCompactSessions,
  listCompactSessions,
  pruneExpiredCompactSessions,
  readCompactSessionRef,
  SAVED_ROW_NOT_FOUND_MESSAGE,
} from "./session-store.js";
import type { CompactSession, CompactSessionSummary, ParsedLogRow } from "./types.js";

export interface ShowFlags {
  readonly json?: boolean;
}

export interface SessionListFlags {
  readonly json?: boolean;
}

export async function runShow(ref: string, flags: ShowFlags): Promise<void> {
  try {
    const result = await readCompactSessionRef(ref);
    if (flags.json === true) {
      writeJson(result);
      return;
    }
    writeRaw(formatFullSavedRow(result));
  } catch (error) {
    if (error instanceof Error && error.message === SAVED_ROW_NOT_FOUND_MESSAGE) {
      throw error;
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function runSessionList(flags: SessionListFlags): Promise<void> {
  const sessions = await listCompactSessions();
  if (flags.json === true) {
    writeJson(sessions);
    return;
  }
  if (sessions.length === 0) {
    process.stdout.write("(empty)\n");
    return;
  }
  for (const session of sessions) {
    process.stdout.write(`${formatSessionSummary(session)}\n`);
  }
}

export async function runSessionPrune(): Promise<void> {
  const removed = await pruneExpiredCompactSessions();
  process.stdout.write(`Pruned ${removed.toString()} session(s) from ${cfLogsSessionsDir()}\n`);
}

export async function runSessionClear(): Promise<void> {
  const removed = await clearCompactSessions();
  process.stdout.write(`Cleared ${removed.toString()} session(s) from ${cfLogsSessionsDir()}\n`);
}

function formatSessionSummary(session: CompactSessionSummary): string {
  return [
    session.sessionId,
    `rows=${session.rowCount.toString()}`,
    `expiresAt=${session.expiresAt}`,
    session.target === undefined ? "" : `${session.target.org}/${session.target.space}/${session.target.app}`,
  ].filter((item) => item.length > 0).join("\t");
}

function formatFullSavedRow(result: {
  readonly ref: string;
  readonly session: CompactSession;
  readonly row: ParsedLogRow;
}): string {
  const row = result.row;
  return [
    `ref=${result.ref}`,
    `session=${result.session.sessionId}`,
    `time=${row.timestampRaw}`,
    `level=${row.level}`,
    `source=${row.source}`,
    `stream=${row.stream}`,
    row.logger.length === 0 ? "" : `logger=${row.logger}`,
    row.requestId.length === 0 ? "" : `requestId=${row.requestId}`,
    row.status.length === 0 ? "" : `status=${row.status}`,
    row.latency.length === 0 ? "" : `latency=${row.latency}`,
    "",
    row.message,
    "",
    row.rawBody,
  ].filter((line) => line.length > 0).join("\n");
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeRaw(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}
