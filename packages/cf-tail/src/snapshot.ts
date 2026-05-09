import {
  appendRawLogText,
  buildRedactionRules,
  fetchRecentLogsFromTarget as defaultFetchRecentLogsFromTarget,
  parseRecentLogs,
  persistSnapshot as defaultPersistSnapshot,
  prepareCfCliSession as defaultPrepareCfCliSession,
  redactText,
  resolveApiEndpoint,
} from "@saptools/cf-logs";
import type {
  AppCatalogEntry,
  CfSessionInput,
  ParsedLogRow,
  RedactionRule,
} from "@saptools/cf-logs";

import { discoverMatchingApps } from "./discovery.js";
import { mergeAppRows, tagRowsWithApp } from "./merge.js";
import type {
  AppFilterInput,
  AppSnapshotError,
  AppSnapshotResult,
  MultiSnapshotInput,
  MultiSnapshotResult,
  SnapshotDependencies,
} from "./types.js";

const DEFAULT_CONCURRENCY = 4;

export interface FetchSnapshotsForAppsInput extends AppFilterInput {
  readonly session: CfSessionInput;
  readonly apps: readonly AppCatalogEntry[];
  readonly concurrency?: number;
  readonly logLimit?: number;
  readonly persist?: boolean;
  readonly extraSecrets?: readonly string[];
  readonly now?: () => Date;
  readonly dependencies?: SnapshotDependencies;
}

export async function fetchMultiSnapshot(
  input: MultiSnapshotInput & { readonly dependencies?: SnapshotDependencies },
): Promise<MultiSnapshotResult> {
  const session: CfSessionInput = {
    ...(input.apiEndpoint === undefined ? {} : { apiEndpoint: input.apiEndpoint }),
    ...(input.region === undefined ? {} : { region: input.region }),
    email: input.email,
    password: input.password,
    org: input.org,
    space: input.space,
    ...(input.cfHomeDir === undefined ? {} : { cfHomeDir: input.cfHomeDir }),
    ...(input.command === undefined ? {} : { command: input.command }),
  };
  const apps = await discoverMatchingApps({ ...session, ...toFilterInput(input) });
  return await fetchSnapshotsForApps({
    session,
    apps,
    ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
    ...(input.logLimit === undefined ? {} : { logLimit: input.logLimit }),
    ...(input.persist === undefined ? {} : { persist: input.persist }),
    ...(input.extraSecrets === undefined ? {} : { extraSecrets: input.extraSecrets }),
    ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }),
  });
}

export async function fetchSnapshotsForApps(
  input: FetchSnapshotsForAppsInput,
): Promise<MultiSnapshotResult> {
  const concurrency = resolvePositiveInt(input.concurrency, DEFAULT_CONCURRENCY);
  const fetchedAt = (input.now?.() ?? new Date()).toISOString();
  const apps = [...input.apps];
  if (apps.length === 0) {
    return { fetchedAt, apps: [], merged: [], errors: [] };
  }
  const prepareSessionFn = input.dependencies?.prepareSession ?? defaultPrepareCfCliSession;
  const fetchRecentLogsFn =
    input.dependencies?.fetchRecentLogsFromTarget ?? defaultFetchRecentLogsFromTarget;
  const persistFn = input.dependencies?.persistSnapshot ?? defaultPersistSnapshot;

  await prepareSessionFn(input.session);
  const rules = buildSnapshotRedactionRules(input.session, input.extraSecrets);

  const successes: AppSnapshotResult[] = [];
  const errors: AppSnapshotError[] = [];
  const shouldPersist = input.persist === true;

  await runWithConcurrency(apps, concurrency, async (app) => {
    try {
      const result = await fetchSnapshotForApp({
        session: input.session,
        appName: app.name,
        rules,
        fetchedAt,
        fetchRecentLogsFn,
        persistFn,
        shouldPersist,
        ...(input.logLimit === undefined ? {} : { logLimit: input.logLimit }),
      });
      successes.push(result);
    } catch (error) {
      errors.push({
        appName: app.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  successes.sort((left, right) => left.appName.localeCompare(right.appName));
  errors.sort((left, right) => left.appName.localeCompare(right.appName));

  const rowsByApp = new Map<string, readonly ParsedLogRow[]>();
  for (const result of successes) {
    rowsByApp.set(result.appName, result.rows);
  }

  return {
    fetchedAt,
    apps: successes,
    merged: mergeAppRows(rowsByApp),
    errors,
  };
}

interface FetchSnapshotForAppInput {
  readonly session: CfSessionInput;
  readonly appName: string;
  readonly rules: readonly RedactionRule[];
  readonly fetchedAt: string;
  readonly fetchRecentLogsFn: NonNullable<SnapshotDependencies["fetchRecentLogsFromTarget"]>;
  readonly persistFn: NonNullable<SnapshotDependencies["persistSnapshot"]>;
  readonly shouldPersist: boolean;
  readonly logLimit?: number;
}

async function fetchSnapshotForApp(
  input: FetchSnapshotForAppInput,
): Promise<AppSnapshotResult> {
  const rawLogs = await input.fetchRecentLogsFn({
    appName: input.appName,
    ...(input.session.cfHomeDir === undefined ? {} : { cfHomeDir: input.session.cfHomeDir }),
    ...(input.session.command === undefined ? {} : { command: input.session.command }),
  });
  const safeRawLogs = redactText(rawLogs, input.rules);
  const parseOptions = input.logLimit === undefined ? {} : { logLimit: input.logLimit };
  const boundedRawLogs = appendRawLogText("", safeRawLogs, parseOptions);
  const rows = parseRecentLogs(boundedRawLogs, parseOptions);
  const result: AppSnapshotResult = {
    appName: input.appName,
    rawText: boundedRawLogs,
    rows,
    fetchedAt: input.fetchedAt,
    truncated: safeRawLogs.length > boundedRawLogs.length,
  };
  if (input.shouldPersist) {
    await input.persistFn({
      key: {
        apiEndpoint: resolveApiEndpoint(input.session),
        org: input.session.org,
        space: input.session.space,
        app: input.appName,
      },
      rawText: boundedRawLogs,
      rows,
      fetchedAt: input.fetchedAt,
      ...(input.logLimit === undefined ? {} : { logLimit: input.logLimit }),
    });
  }
  return result;
}

export function buildSnapshotRedactionRules(
  session: CfSessionInput,
  extraSecrets: readonly string[] | undefined,
): readonly RedactionRule[] {
  return buildRedactionRules({
    email: session.email,
    password: session.password,
    ...(extraSecrets === undefined ? {} : { secrets: extraSecrets }),
  });
}

export function tagSnapshotRows(result: AppSnapshotResult): readonly ParsedLogRow[] {
  return tagRowsWithApp(result.appName, result.rows);
}

function toFilterInput(input: AppFilterInput): AppFilterInput {
  return {
    ...(input.include === undefined ? {} : { include: input.include }),
    ...(input.exclude === undefined ? {} : { exclude: input.exclude }),
    ...(input.includeRegex === undefined ? {} : { includeRegex: input.includeRegex }),
    ...(input.excludeRegex === undefined ? {} : { excludeRegex: input.excludeRegex }),
  };
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers: Promise<void>[] = [];
  const limit = Math.min(concurrency, queue.length);
  for (let index = 0; index < limit; index += 1) {
    workers.push(
      (async (): Promise<void> => {
        for (;;) {
          const next = queue.shift();
          if (next === undefined) {
            return;
          }
          await worker(next);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

function resolvePositiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
