import { resolveApiEndpoint } from "./cf.js";
import {
  buildCompactLogDocument,
  compactLogRows,
  DEFAULT_COMPACT_MESSAGE_LIMIT,
  formatCompactRows,
} from "./compact.js";
import {
  appendCompactSessionRows,
  createCompactSession,
  DEFAULT_COMPACT_SESSION_TTL_MINUTES,
  formatCompactRowRef,
} from "./session-store.js";
import type {
  CfLogsRuntimeEvent,
  CfSessionInput,
  CompactLogDocument,
  CompactLogRowRef,
  CompactSession,
  ParsedLogRow,
} from "./types.js";

export interface CompactCliFlags {
  readonly compactMessageLimit?: number;
  readonly compactTtlMinutes?: number;
  readonly logLimit?: number;
  readonly json?: boolean;
  readonly save?: boolean;
}

export async function buildSnapshotCompactDocument(
  session: CfSessionInput,
  snapshot: {
    readonly appName: string;
    readonly fetchedAt: string;
    readonly rows: readonly ParsedLogRow[];
    readonly truncated: boolean;
  },
  flags: CompactCliFlags,
): Promise<CompactLogDocument> {
  const saved = flags.save === true
    ? await createCompactSession({
        ttlMinutes: resolveCompactTtlMinutes(flags.compactTtlMinutes),
        target: buildSessionTarget(session, snapshot.appName),
        rows: snapshot.rows,
        ...(flags.logLimit === undefined ? {} : { logLimit: flags.logLimit }),
      })
    : undefined;
  return buildCompactLogDocument(
    {
      appName: snapshot.appName,
      generatedAt: snapshot.fetchedAt,
      rows: snapshot.rows,
      truncated: snapshot.truncated,
      ...(saved === undefined ? {} : { refs: buildRefs(saved, snapshot.rows) }),
    },
    buildCompactOptions(flags),
  );
}

export async function createCompactStreamSession(
  session: CfSessionInput,
  appName: string,
  flags: CompactCliFlags,
): Promise<CompactSession | undefined> {
  if (flags.save !== true) {
    return undefined;
  }
  return await createCompactSession({
    ttlMinutes: resolveCompactTtlMinutes(flags.compactTtlMinutes),
    target: buildSessionTarget(session, appName),
    ...(flags.logLimit === undefined ? {} : { logLimit: flags.logLimit }),
  });
}

export async function printCompactAppendRows(
  event: Extract<CfLogsRuntimeEvent, { readonly type: "append" }>,
  flags: CompactCliFlags,
  compactSession: CompactSession | undefined,
  lastEmittedRowId: number,
): Promise<number> {
  const rows = event.state.rows.filter((row) => row.id > lastEmittedRowId);
  if (rows.length === 0) {
    return 0;
  }
  const refs = await buildAppendRefs(compactSession, rows, flags.logLimit);
  const compactRows = compactLogRows(rows, { ...buildCompactOptions(flags), refs });
  if (flags.json === true) {
    writeJsonLine({ type: "rows", appName: event.appName, rows: compactRows });
  } else {
    writeRaw(formatCompactRows(compactRows));
  }
  return compactRows.length;
}

function buildCompactOptions(flags: CompactCliFlags): { readonly messageLimit: number } {
  return {
    messageLimit: flags.compactMessageLimit ?? DEFAULT_COMPACT_MESSAGE_LIMIT,
  };
}

async function buildAppendRefs(
  compactSession: CompactSession | undefined,
  rows: readonly ParsedLogRow[],
  logLimit: number | undefined,
): Promise<readonly CompactLogRowRef[]> {
  if (compactSession === undefined) {
    return [];
  }
  const session = await appendCompactSessionRows({
    sessionId: compactSession.sessionId,
    rows,
    ...(logLimit === undefined ? {} : { logLimit }),
  });
  return buildRefs(session, rows);
}

function resolveCompactTtlMinutes(value: number | undefined): number {
  return value ?? DEFAULT_COMPACT_SESSION_TTL_MINUTES;
}

function buildSessionTarget(
  session: CfSessionInput,
  appName: string,
): {
  readonly apiEndpoint: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
} {
  return {
    apiEndpoint: resolveApiEndpoint(session),
    org: session.org,
    space: session.space,
    app: appName,
  };
}

function buildRefs(session: CompactSession, rows: readonly ParsedLogRow[]): readonly CompactLogRowRef[] {
  return rows.map((row) => ({
    rowId: row.id,
    ref: formatCompactRowRef(session.sessionId, row.id),
  }));
}

function writeJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeRaw(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}
