import { CfLogsRuntime } from "@saptools/cf-logs";
import type {
  AppCatalogEntry,
  CfLogsRuntimeEvent,
  CfLogsRuntimeOptions,
  CfSessionInput,
  ParsedLogRow,
  RedactionRule,
  RuntimeAppState,
  RuntimeDependencies,
} from "@saptools/cf-logs";

import { diffAppCatalogs, discoverMatchingApps } from "./discovery.js";
import { applyAppFilter, buildAppFilter } from "./filters.js";
import { tagRowsWithApp } from "./merge.js";
import type {
  AppFilterInput,
  CfTailEvent,
  CfTailRuntimeDependencies,
  CfTailRuntimeOptions,
  TailLogRow,
} from "./types.js";

const DEFAULT_REDISCOVER_INTERVAL_MS = 30_000;

export class CfTailRuntime {
  private readonly listeners = new Set<(event: CfTailEvent) => void>();
  private readonly logsRuntime: CfLogsRuntime;
  private readonly rediscoverIntervalMs: number;
  private readonly now: () => Date;
  private readonly discoverApps: (
    input: CfSessionInput & AppFilterInput,
  ) => Promise<readonly AppCatalogEntry[]>;
  private readonly lastRowIdByApp = new Map<string, number>();
  private session: CfSessionInput | null = null;
  private filterInput: AppFilterInput = {};
  private currentApps: readonly AppCatalogEntry[] = [];
  private rediscoverTimer: NodeJS.Timeout | undefined;
  private started = false;
  private stopped = false;
  private discoveryRefreshes = 0;

  constructor(
    options: CfTailRuntimeOptions = {},
    dependencies: CfTailRuntimeDependencies = {},
  ) {
    this.rediscoverIntervalMs = resolveNonNegative(
      options.rediscoverIntervalMs,
      DEFAULT_REDISCOVER_INTERVAL_MS,
    );
    this.now = options.now ?? (() => new Date());
    this.discoverApps = dependencies.discoverApps ?? discoverMatchingApps;
    this.logsRuntime = new CfLogsRuntime(
      buildLogsRuntimeOptions(options, options.extraSecrets ?? []),
      pickLogsRuntimeDependencies(dependencies),
    );
    this.logsRuntime.subscribe((event) => {
      this.handleLogsRuntimeEvent(event);
    });
  }

  setSession(session: CfSessionInput | null): void {
    this.session = session;
    this.logsRuntime.setSession(session);
    this.currentApps = [];
    this.logsRuntime.setAvailableApps([]);
    this.lastRowIdByApp.clear();
    this.discoveryRefreshes = 0;
  }

  setAppFilter(filter: AppFilterInput): void {
    this.filterInput = { ...filter };
  }

  subscribe(listener: (event: CfTailEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listAppStates(): readonly RuntimeAppState[] {
    return this.logsRuntime.listStates();
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stopped = false;
    await this.refreshDiscovery();
    if (this.rediscoverIntervalMs > 0) {
      this.scheduleRediscovery();
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.started = false;
    if (this.rediscoverTimer !== undefined) {
      clearTimeout(this.rediscoverTimer);
      this.rediscoverTimer = undefined;
    }
    await this.logsRuntime.dispose();
    this.logsRuntime.setAvailableApps([]);
    this.currentApps = [];
    this.lastRowIdByApp.clear();
  }

  async refreshDiscovery(): Promise<readonly AppCatalogEntry[]> {
    if (this.session === null) {
      throw new Error("No CF session configured.");
    }
    const sessionSnapshot = this.session;
    let nextApps: readonly AppCatalogEntry[];
    try {
      nextApps = await this.discoverApps({ ...sessionSnapshot, ...this.filterInput });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: "discovery-error",
        message,
        at: this.now().toISOString(),
      });
      throw error;
    }
    const filter = buildAppFilter(this.filterInput);
    const filteredApps = applyAppFilter(nextApps, filter);
    const { addedApps, removedApps } = diffAppCatalogs(this.currentApps, filteredApps);
    const initial = this.discoveryRefreshes === 0;
    const changed = addedApps.length > 0 || removedApps.length > 0;
    this.discoveryRefreshes += 1;
    this.currentApps = filteredApps;
    this.logsRuntime.setAvailableApps(filteredApps);
    for (const removed of removedApps) {
      this.lastRowIdByApp.delete(removed);
    }
    await this.logsRuntime.setActiveApps(filteredApps.map((app) => app.name));
    this.emit({
      type: "discovery",
      apps: filteredApps,
      addedApps,
      removedApps,
      initial,
      changed,
      at: this.now().toISOString(),
    });
    return filteredApps;
  }

  private scheduleRediscovery(): void {
    if (this.stopped) {
      return;
    }
    this.rediscoverTimer = setTimeout(() => {
      this.rediscoverTimer = undefined;
      void this.runScheduledRediscovery();
    }, this.rediscoverIntervalMs);
  }

  private async runScheduledRediscovery(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      await this.refreshDiscovery();
    } catch {
      // discovery-error already emitted by refreshDiscovery
    }
    // stop() may flip this.stopped while refreshDiscovery awaits.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!this.stopped) {
      this.scheduleRediscovery();
    }
  }

  private handleLogsRuntimeEvent(event: CfLogsRuntimeEvent): void {
    if (event.type === "append") {
      const newRows = this.computeNewRows(event.appName, event.state.rows);
      this.emit({
        type: "lines",
        appName: event.appName,
        lines: event.lines,
        rows: newRows,
        state: event.state,
      });
      return;
    }
    if (event.type === "stream-state") {
      this.emit({
        type: "stream-state",
        appName: event.appName,
        streamState: event.streamState,
      });
    }
  }

  private computeNewRows(
    appName: string,
    cumulativeRows: readonly ParsedLogRow[],
  ): readonly TailLogRow[] {
    const lastId = this.lastRowIdByApp.get(appName) ?? 0;
    const fresh: ParsedLogRow[] = [];
    for (const row of cumulativeRows) {
      if (row.id > lastId) {
        fresh.push(row);
      }
    }
    if (fresh.length === 0) {
      return [];
    }
    const newMaxId = fresh[fresh.length - 1]?.id ?? lastId;
    this.lastRowIdByApp.set(appName, newMaxId);
    return tagRowsWithApp(appName, fresh);
  }

  private emit(event: CfTailEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function resolveNonNegative(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return value < 0 ? 0 : value;
}

function buildLogsRuntimeOptions(
  options: CfTailRuntimeOptions,
  extraSecrets: readonly string[],
): CfLogsRuntimeOptions {
  const redactionRules: RedactionRule[] = extraSecrets
    .filter((value) => value.length > 0)
    .map((value) => ({ value, replacement: "***" }));
  return {
    ...(options.logLimit === undefined ? {} : { logLimit: options.logLimit }),
    ...(options.flushIntervalMs === undefined ? {} : { flushIntervalMs: options.flushIntervalMs }),
    ...(options.retryInitialMs === undefined ? {} : { retryInitialMs: options.retryInitialMs }),
    ...(options.retryMaxMs === undefined ? {} : { retryMaxMs: options.retryMaxMs }),
    ...(options.persistStreamAppends === undefined
      ? {}
      : { persistStreamAppends: options.persistStreamAppends }),
    ...(redactionRules.length === 0 ? {} : { redactionRules }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
}

function pickLogsRuntimeDependencies(
  dependencies: CfTailRuntimeDependencies,
): RuntimeDependencies {
  return {
    ...(dependencies.prepareSession === undefined
      ? {}
      : { prepareSession: dependencies.prepareSession }),
    ...(dependencies.fetchRecentLogsFromTarget === undefined
      ? {}
      : { fetchRecentLogsFromTarget: dependencies.fetchRecentLogsFromTarget }),
    ...(dependencies.spawnLogStreamFromTarget === undefined
      ? {}
      : { spawnLogStreamFromTarget: dependencies.spawnLogStreamFromTarget }),
    ...(dependencies.persistSnapshot === undefined
      ? {}
      : { persistSnapshot: dependencies.persistSnapshot }),
  };
}
