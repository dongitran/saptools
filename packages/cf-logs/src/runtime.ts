import { fetchRecentLogsFromTarget, prepareCfCliSession, resolveApiEndpoint, spawnLogStreamFromTarget } from "./cf.js";
import { appendParsedLines, appendRawLogText, DEFAULT_LOG_LIMIT, parseRecentLogs } from "./parser.js";
import { buildRedactionRules, redactText } from "./redact.js";
import { persistSnapshot } from "./store.js";
import type {
  AppCatalogEntry,
  CfLogsRuntimeEvent,
  CfLogsRuntimeOptions,
  CfSessionInput,
  LogStreamHandle,
  LogSnapshot,
  RedactionRule,
  RuntimeAppState,
  RuntimeDependencies,
  RuntimeStreamState,
} from "./types.js";

const DEFAULT_FLUSH_INTERVAL_MS = 150;
const DEFAULT_RETRY_INITIAL_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 20_000;

type InternalAppState = RuntimeAppState;

interface RunningStream {
  readonly appName: string;
  readonly handle: LogStreamHandle;
  readonly sessionVersion: number;
  lineBuffer: string[];
  lineRemainder: string;
  flushTimer: NodeJS.Timeout | undefined;
  stoppedByRequest: boolean;
}

export class CfLogsRuntime {
  private readonly listeners = new Set<(event: CfLogsRuntimeEvent) => void>();
  private readonly dependencies: Required<RuntimeDependencies>;
  private readonly logLimit: number;
  private readonly flushIntervalMs: number;
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;
  private readonly now: () => Date;
  private session: CfSessionInput | null = null;
  private sessionVersion = 0;
  private preparedVersion = -1;
  private prepareSessionPromise: Promise<void> | null = null;
  private preparingVersion = -1;
  private readonly availableApps = new Map<string, AppCatalogEntry>();
  private readonly states = new Map<string, InternalAppState>();
  private readonly activeAppNames = new Set<string>();
  private readonly runningStreams = new Map<string, RunningStream>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly reconnectDelays = new Map<string, number>();

  constructor(
    private readonly options: CfLogsRuntimeOptions = {},
    dependencies: RuntimeDependencies = {},
  ) {
    this.dependencies = {
      prepareSession: dependencies.prepareSession ?? prepareCfCliSession,
      fetchRecentLogsFromTarget:
        dependencies.fetchRecentLogsFromTarget ?? fetchRecentLogsFromTarget,
      spawnLogStreamFromTarget:
        dependencies.spawnLogStreamFromTarget ?? spawnLogStreamFromTarget,
      persistSnapshot: dependencies.persistSnapshot ?? persistSnapshot,
    };
    this.logLimit = resolvePositiveNumber(options.logLimit, DEFAULT_LOG_LIMIT);
    this.flushIntervalMs = resolvePositiveNumber(options.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS);
    this.retryInitialMs = resolvePositiveNumber(options.retryInitialMs, DEFAULT_RETRY_INITIAL_MS);
    this.retryMaxMs = resolvePositiveNumber(options.retryMaxMs, DEFAULT_RETRY_MAX_MS);
    this.now = options.now ?? (() => new Date());
  }

  subscribe(listener: (event: CfLogsRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setSession(session: CfSessionInput | null): void {
    this.session = session;
    this.sessionVersion += 1;
    this.preparedVersion = -1;
    this.prepareSessionPromise = null;
    this.preparingVersion = -1;
    this.stopAllStreams(true);
  }

  setAvailableApps(apps: readonly AppCatalogEntry[]): void {
    const nextApps = new Map<string, AppCatalogEntry>();
    for (const app of apps) {
      const name = app.name.trim();
      if (name.length === 0 || nextApps.has(name)) {
        continue;
      }
      nextApps.set(name, { name, runningInstances: app.runningInstances });
      this.states.set(name, this.mergeState(name, { runningInstances: app.runningInstances }));
    }
    for (const appName of this.states.keys()) {
      if (!nextApps.has(appName)) {
        this.stopStream(appName, true);
        this.states.delete(appName);
      }
    }
    this.availableApps.clear();
    for (const [name, app] of nextApps) {
      this.availableApps.set(name, app);
    }
  }

  async setActiveApps(appNames: readonly string[]): Promise<void> {
    const nextActive = new Set<string>();
    for (const appName of appNames) {
      const normalized = appName.trim();
      if (normalized.length > 0 && this.availableApps.has(normalized)) {
        nextActive.add(normalized);
      }
    }

    for (const activeName of [...this.activeAppNames]) {
      if (!nextActive.has(activeName)) {
        this.activeAppNames.delete(activeName);
        this.stopStream(activeName, true);
      }
    }

    for (const nextName of nextActive) {
      this.activeAppNames.add(nextName);
    }

    for (const nextName of nextActive) {
      await this.startStreamIfNeeded(nextName);
    }
  }

  async fetchSnapshot(appName: string): Promise<LogSnapshot> {
    const session = this.requireSession();
    this.requireAvailableApp(appName);
    const expectedVersion = this.sessionVersion;
    await this.ensurePrepared(expectedVersion);
    const fetchedAt = this.now().toISOString();
    const rawLogs = await this.fetchRecentLogsWithRecovery(session, appName, expectedVersion);
    const safeRawLogs = this.sanitizeText(rawLogs);
    const boundedRawLogs = appendRawLogText("", safeRawLogs, { logLimit: this.logLimit });
    const rows = parseRecentLogs(boundedRawLogs, { logLimit: this.logLimit });
    const snapshot = {
      appName,
      rawText: boundedRawLogs,
      rows,
      fetchedAt,
      truncated: safeRawLogs.length > boundedRawLogs.length,
    } satisfies LogSnapshot;
    this.states.set(appName, this.mergeState(appName, { rawText: boundedRawLogs, rows, updatedAt: fetchedAt }));
    await this.persistIfEnabled(snapshot, false);
    this.emit({ type: "snapshot", appName, snapshot });
    return snapshot;
  }

  getState(appName: string): RuntimeAppState | undefined {
    const state = this.states.get(appName);
    return state === undefined ? undefined : { ...state, rows: [...state.rows] };
  }

  listStates(): readonly RuntimeAppState[] {
    return [...this.states.values()].sort((left, right) => left.appName.localeCompare(right.appName));
  }

  dispose(): Promise<void> {
    this.stopAllStreams(false);
    return Promise.resolve();
  }

  private emit(event: CfLogsRuntimeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private requireSession(): CfSessionInput {
    if (this.session === null) {
      throw new Error("No CF session configured.");
    }
    return this.session;
  }

  private requireAvailableApp(appName: string): void {
    if (!this.availableApps.has(appName)) {
      throw new Error(`Unknown app: ${appName}`);
    }
  }

  private mergeState(appName: string, patch: Partial<RuntimeAppState>): InternalAppState {
    const existing = this.states.get(appName);
    const runningInstances = patch.runningInstances ?? existing?.runningInstances ?? this.availableApps.get(appName)?.runningInstances ?? 0;
    return {
      appName,
      runningInstances,
      rawText: patch.rawText ?? existing?.rawText ?? "",
      rows: patch.rows ?? existing?.rows ?? [],
      ...(patch.updatedAt === undefined ? (existing?.updatedAt === undefined ? {} : { updatedAt: existing.updatedAt }) : { updatedAt: patch.updatedAt }),
      ...(patch.streamState === undefined ? (existing?.streamState === undefined ? {} : { streamState: existing.streamState }) : { streamState: patch.streamState }),
    };
  }

  private async ensurePrepared(expectedVersion: number): Promise<void> {
    if (this.preparedVersion === expectedVersion) {
      return;
    }
    if (this.prepareSessionPromise !== null && this.preparingVersion === expectedVersion) {
      await this.prepareSessionPromise;
      if (this.sessionVersion !== expectedVersion) {
        throw new Error("CF session changed while preparing logs.");
      }
      return;
    }
    const session = this.requireSession();
    const promise = (async (): Promise<void> => {
      await this.dependencies.prepareSession(session);
      if (this.sessionVersion !== expectedVersion) {
        throw new Error("CF session changed while preparing logs.");
      }
      this.preparedVersion = expectedVersion;
    })();
    this.prepareSessionPromise = promise;
    this.preparingVersion = expectedVersion;
    try {
      await promise;
    } finally {
      if (this.prepareSessionPromise === promise) {
        this.prepareSessionPromise = null;
        this.preparingVersion = -1;
      }
    }
  }

  private async fetchRecentLogsWithRecovery(
    session: CfSessionInput,
    appName: string,
    expectedVersion: number,
  ): Promise<string> {
    const fetchOnce = async (): Promise<string> =>
      await this.dependencies.fetchRecentLogsFromTarget({
        appName,
        ...(session.cfHomeDir === undefined ? {} : { cfHomeDir: session.cfHomeDir }),
        ...(session.command === undefined ? {} : { command: session.command }),
      });
    try {
      return await fetchOnce();
    } catch (error) {
      if (!shouldRetryPreparedSession(error) || this.sessionVersion !== expectedVersion) {
        throw error;
      }
      this.preparedVersion = -1;
      await this.ensurePrepared(expectedVersion);
      return await fetchOnce();
    }
  }

  private async startStreamIfNeeded(appName: string): Promise<void> {
    if (!this.activeAppNames.has(appName) || this.runningStreams.has(appName) || this.session === null) {
      return;
    }
    const expectedVersion = this.sessionVersion;
    this.postStreamState(appName, { status: "starting", updatedAt: this.now().toISOString() });

    try {
      await this.ensurePrepared(expectedVersion);
      if (!this.activeAppNames.has(appName) || this.sessionVersion !== expectedVersion) {
        return;
      }
      const currentSession = this.requireSession();
      const handle = this.dependencies.spawnLogStreamFromTarget({
        appName,
        ...(currentSession.cfHomeDir === undefined ? {} : { cfHomeDir: currentSession.cfHomeDir }),
        ...(currentSession.command === undefined ? {} : { command: currentSession.command }),
      });
      const stream: RunningStream = { appName, handle, sessionVersion: expectedVersion, lineBuffer: [], lineRemainder: "", flushTimer: undefined, stoppedByRequest: false };
      this.runningStreams.set(appName, stream);
      this.attachStreamListeners(stream);
      this.reconnectDelays.delete(appName);
      this.postStreamState(appName, { status: "streaming", updatedAt: this.now().toISOString() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start log stream.";
      this.postStreamState(appName, { status: "error", message, updatedAt: this.now().toISOString() });
      this.scheduleReconnect(appName);
    }
  }

  private attachStreamListeners(stream: RunningStream): void {
    stream.handle.process.stdout.on("data", (chunk) => {
      this.handleStreamChunk(stream, chunk.toString());
    });
    stream.handle.process.stderr.on("data", (chunk) => {
      this.handleStreamChunk(stream, chunk.toString());
    });
    stream.handle.process.on("exit", (code, signal) => {
      void this.handleStreamExit(stream, code, signal);
    });
    stream.handle.process.on("error", (error) => {
      void this.handleStreamError(stream, error);
    });
  }

  private handleStreamChunk(stream: RunningStream, chunkText: string): void {
    const { lines, remainder } = splitLines(stream.lineRemainder, this.sanitizeText(chunkText));
    stream.lineRemainder = remainder;
    if (lines.length === 0) {
      return;
    }
    stream.lineBuffer.push(...lines);
    if (stream.flushTimer !== undefined) {
      return;
    }
    stream.flushTimer = setTimeout(() => {
      void this.flushStreamBuffer(stream, false);
    }, this.flushIntervalMs);
  }

  private async handleStreamExit(
    stream: RunningStream,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (this.runningStreams.get(stream.appName) !== stream) {
      return;
    }
    await this.flushStreamBuffer(stream, true);
    this.runningStreams.delete(stream.appName);
    if (stream.stoppedByRequest || !this.activeAppNames.has(stream.appName) || stream.sessionVersion !== this.sessionVersion) {
      this.postStreamState(stream.appName, { status: "stopped", updatedAt: this.now().toISOString() });
      return;
    }
    const message = `Stream exited (${String(code ?? "")}${signal === null ? "" : ` ${signal}`}).`;
    this.postStreamState(stream.appName, { status: "reconnecting", message, updatedAt: this.now().toISOString() });
    this.scheduleReconnect(stream.appName);
  }

  private async handleStreamError(stream: RunningStream, error: Error): Promise<void> {
    if (this.runningStreams.get(stream.appName) !== stream) {
      return;
    }
    await this.flushStreamBuffer(stream, true);
    this.runningStreams.delete(stream.appName);
    if (stream.stoppedByRequest || !this.activeAppNames.has(stream.appName) || stream.sessionVersion !== this.sessionVersion) {
      this.postStreamState(stream.appName, { status: "stopped", updatedAt: this.now().toISOString() });
      return;
    }
    this.postStreamState(stream.appName, { status: "error", message: error.message, updatedAt: this.now().toISOString() });
    this.scheduleReconnect(stream.appName);
  }

  private async flushStreamBuffer(stream: RunningStream, includeRemainder: boolean): Promise<void> {
    if (stream.flushTimer !== undefined) {
      clearTimeout(stream.flushTimer);
      stream.flushTimer = undefined;
    }
    if (includeRemainder && stream.lineRemainder.length > 0) {
      stream.lineBuffer.push(stream.lineRemainder);
      stream.lineRemainder = "";
    }
    if (stream.lineBuffer.length === 0) {
      return;
    }
    const lines = [...stream.lineBuffer];
    stream.lineBuffer = [];
    const existing = this.states.get(stream.appName) ?? this.mergeState(stream.appName, {});
    const rawText = appendRawLogText(existing.rawText, lines.join("\n"), { logLimit: this.logLimit });
    const rows = appendParsedLines(existing.rows, lines, { logLimit: this.logLimit });
    const updatedAt = this.now().toISOString();
    const state = this.mergeState(stream.appName, { rawText, rows, updatedAt });
    this.states.set(stream.appName, state);
    await this.persistIfEnabled({ appName: stream.appName, rawText, rows, fetchedAt: updatedAt, truncated: false }, true);
    this.emit({ type: "append", appName: stream.appName, lines, state });
  }

  private postStreamState(appName: string, streamState: RuntimeStreamState): void {
    const state = this.mergeState(appName, { streamState });
    this.states.set(appName, state);
    this.emit({ type: "stream-state", appName, streamState });
  }

  private scheduleReconnect(appName: string): void {
    if (!this.activeAppNames.has(appName) || this.reconnectTimers.has(appName)) {
      return;
    }
    const delayMs = this.reconnectDelays.get(appName) ?? this.retryInitialMs;
    const nextDelay = Math.min(delayMs * 2, this.retryMaxMs);
    this.reconnectDelays.set(appName, nextDelay);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(appName);
      void this.startStreamIfNeeded(appName);
    }, delayMs);
    this.reconnectTimers.set(appName, timer);
  }

  private stopAllStreams(notify: boolean): void {
    for (const appName of [...this.runningStreams.keys()]) {
      this.stopStream(appName, notify);
    }
    for (const [appName, timer] of this.reconnectTimers) {
      clearTimeout(timer);
      this.reconnectTimers.delete(appName);
      if (notify) {
        this.postStreamState(appName, { status: "stopped", updatedAt: this.now().toISOString() });
      }
    }
    this.reconnectDelays.clear();
  }

  private stopStream(appName: string, notify: boolean): void {
    const stream = this.runningStreams.get(appName);
    if (stream === undefined) {
      return;
    }
    stream.stoppedByRequest = true;
    if (stream.flushTimer !== undefined) {
      clearTimeout(stream.flushTimer);
      stream.flushTimer = undefined;
    }
    stream.handle.stop();
    this.runningStreams.delete(appName);
    const timer = this.reconnectTimers.get(appName);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.reconnectTimers.delete(appName);
    }
    this.reconnectDelays.delete(appName);
    if (notify) {
      this.postStreamState(appName, { status: "stopped", updatedAt: this.now().toISOString() });
    }
  }

  private sanitizeText(text: string): string {
    return redactText(text, this.buildRuntimeRedactionRules());
  }

  private buildRuntimeRedactionRules(): readonly RedactionRule[] {
    const base = buildRedactionRules({
      ...(this.session?.email === undefined ? {} : { email: this.session.email }),
      ...(this.session?.password === undefined ? {} : { password: this.session.password }),
    });
    const seen = new Set(base.map((rule) => rule.value));
    const rules = [...base];
    for (const rule of this.options.redactionRules ?? []) {
      if (rule.value.length === 0 || seen.has(rule.value)) {
        continue;
      }
      seen.add(rule.value);
      rules.push({ value: rule.value, replacement: rule.replacement ?? "***" });
    }
    return rules;
  }

  private async persistIfEnabled(snapshot: LogSnapshot, isAppend: boolean): Promise<void> {
    if ((!isAppend && this.options.persistSnapshots !== true) || (isAppend && this.options.persistStreamAppends !== true) || this.session === null) {
      return;
    }
    await this.dependencies.persistSnapshot({
      key: {
        apiEndpoint: resolveApiEndpoint(this.session),
        org: this.session.org,
        space: this.session.space,
        app: snapshot.appName,
      },
      rawText: snapshot.rawText,
      rows: snapshot.rows,
      fetchedAt: snapshot.fetchedAt,
      logLimit: this.logLimit,
    });
  }
}

function shouldRetryPreparedSession(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.length === 0) {
    return false;
  }
  return (
    message.includes("not logged in") ||
    message.includes("cf login") ||
    message.includes("no org and space targeted") ||
    message.includes("not targeted")
  );
}

function resolvePositiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function splitLines(
  existingRemainder: string,
  chunkText: string,
): { readonly lines: readonly string[]; readonly remainder: string } {
  const combined = `${existingRemainder}${chunkText}`;
  const parts = combined.split(/\r?\n/);
  const remainder = parts.pop() ?? "";
  return { lines: parts.filter((line) => line.length > 0), remainder };
}
