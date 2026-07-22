import { performance } from "node:perf_hooks";

import { CdpClient, createNodeWorkerClient } from "../cdp/client.js";
import { CfInspectorError } from "../types.js";
import type { InspectorConnectOptions, PauseEvent, ScriptInfo } from "../types.js";

import { asString, toPauseEvent, toScriptInfo } from "./conversions.js";
import { discoverInspectorTargets } from "./discovery.js";
import type { InspectorTarget } from "./discovery.js";
import type {
  DebuggerState,
  InspectorSession,
  InspectorSessionGroup,
  InspectorWorkerTarget,
} from "./types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_HOST = "127.0.0.1";
const PAUSE_BUFFER_LIMIT = 32;
const WORKER_DISCOVERY_SETTLE_MS = 500;

export class NodeWorkerDiscovery {
  private readonly workers = new Map<string, InspectorWorkerTarget>();
  private readonly detachListeners: readonly (() => void)[];
  public supported = false;
  private disposed = false;
  private readonly attachedListeners = new Set<(worker: InspectorWorkerTarget) => void>();
  private readonly detachedListeners = new Set<(sessionId: string) => void>();

  public constructor(private readonly client: CdpClient) {
    this.detachListeners = [
      client.on("NodeWorker.attachedToWorker", (raw) => {
        const worker = toInspectorWorkerTarget(raw);
        if (worker !== undefined) {
          this.workers.set(worker.sessionId, worker);
          for (const listener of this.attachedListeners) {
            listener(worker);
          }
        }
      }),
      client.on("NodeWorker.detachedFromWorker", (raw) => {
        const sessionId = readField(raw, "sessionId");
        if (typeof sessionId === "string") {
          this.workers.delete(sessionId);
          for (const listener of this.detachedListeners) {
            listener(sessionId);
          }
        }
      }),
    ];
  }

  public async enable(): Promise<void> {
    try {
      await this.client.send("NodeWorker.enable", { waitForDebuggerOnStart: false });
      this.supported = true;
    } catch (error: unknown) {
      if (!isUnsupportedNodeWorkerDomain(error)) {
        throw error;
      }
    }
  }

  public list(): readonly InspectorWorkerTarget[] {
    return [...this.workers.values()].sort(compareWorkers);
  }

  public onAttached(listener: (worker: InspectorWorkerTarget) => void): () => void {
    this.attachedListeners.add(listener);
    return (): void => {
      this.attachedListeners.delete(listener);
    };
  }

  public onDetached(listener: (sessionId: string) => void): () => void {
    this.detachedListeners.add(listener);
    return (): void => {
      this.detachedListeners.delete(listener);
    };
  }

  public async waitFor(
    predicate: (workers: readonly InspectorWorkerTarget[]) => InspectorWorkerTarget | undefined,
    timeoutMs = WORKER_DISCOVERY_SETTLE_MS,
  ): Promise<InspectorWorkerTarget | undefined> {
    const existing = predicate(this.list());
    if (existing !== undefined) {
      return existing;
    }
    return await new Promise<InspectorWorkerTarget | undefined>((resolve) => {
      let settled = false;
      const finish = (worker?: InspectorWorkerTarget): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        detach();
        resolve(worker);
      };
      const detach = this.onAttached(() => {
        const worker = predicate(this.list());
        if (worker !== undefined) {
          finish(worker);
        }
      });
      const timer = setTimeout(() => {
        finish();
      }, timeoutMs);
    });
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.supported && !this.client.isClosed) {
      try {
        await this.client.send("NodeWorker.disable");
      } catch {
        // best-effort: the parent inspector may already be closing
      }
    }
    for (const detach of this.detachListeners) {
      detach();
    }
    this.attachedListeners.clear();
    this.detachedListeners.clear();
  }
}

function isUnsupportedNodeWorkerDomain(error: unknown): boolean {
  if (!(error instanceof CfInspectorError) || error.code !== "CDP_REQUEST_FAILED") {
    return false;
  }
  return error.detail?.includes('"code":-32601') === true;
}

function compareWorkers(left: InspectorWorkerTarget, right: InspectorWorkerTarget): number {
  const leftId = Number.parseInt(left.workerId, 10);
  const rightId = Number.parseInt(right.workerId, 10);
  if (!Number.isNaN(leftId) && !Number.isNaN(rightId) && leftId !== rightId) {
    return leftId - rightId;
  }
  return left.workerId.localeCompare(right.workerId);
}

function toInspectorWorkerTarget(raw: unknown): InspectorWorkerTarget | undefined {
  const sessionId = readField(raw, "sessionId");
  const info = readField(raw, "workerInfo");
  if (typeof sessionId !== "string" || !isUnknownRecord(info)) {
    return undefined;
  }
  const workerId = asString(info["workerId"]);
  if (workerId.length === 0) {
    return undefined;
  }
  return {
    sessionId,
    workerId,
    type: asString(info["type"]),
    title: asString(info["title"]),
    url: asString(info["url"]),
  };
}

function readField(value: unknown, name: string): unknown {
  return isUnknownRecord(value) ? value[name] : void 0;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function startNodeWorkerDiscovery(client: CdpClient): Promise<NodeWorkerDiscovery> {
  const discovery = new NodeWorkerDiscovery(client);
  await discovery.enable();
  return discovery;
}

export async function connectInspector(options: InspectorConnectOptions): Promise<InspectorSession> {
  const host = options.host ?? DEFAULT_HOST;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const targets = await discoverInspectorTargets(host, options.port, connectTimeoutMs);
  const targetIndex = options.targetIndex ?? 0;
  const target = targets[targetIndex];
  if (!target) {
    throw new CfInspectorError(
      "INSPECTOR_DISCOVERY_FAILED",
      `No inspector target at index ${targetIndex.toString()} on ${host}:${options.port.toString()} (available: ${targets.length.toString()})`,
    );
  }
  const client = await CdpClient.connect({
    url: target.webSocketDebuggerUrl,
    connectTimeoutMs,
  });
  let workerDiscovery: NodeWorkerDiscovery | undefined;
  try {
    workerDiscovery = await startNodeWorkerDiscovery(client);
    if (options.workerIndex === undefined && options.workerId === undefined) {
      const session = await initSession(client, target, { kind: "main" });
      return withWorkerMetadata(session, workerDiscovery, targetIndex, targets.length);
    }
    return await initWorkerSession(
      client,
      workerDiscovery,
      options.workerIndex,
      options.workerId,
      targetIndex,
      targets.length,
    );
  } catch (err: unknown) {
    // The CdpClient is alive (its WS is open) but the inspector handshake
    // failed before we could hand the session to the caller. Dispose so the
    // underlying WS does not leak.
    await workerDiscovery?.dispose();
    client.dispose();
    throw err;
  }
}

async function initWorkerSession(
  parent: CdpClient,
  discovery: NodeWorkerDiscovery,
  workerIndex: number | undefined,
  workerId: string | undefined,
  targetIndex: number,
  targetCount: number,
): Promise<InspectorSession> {
  if (!discovery.supported) {
    throw new CfInspectorError(
      "INSPECTOR_DISCOVERY_FAILED",
      "This runtime does not expose the NodeWorker CDP domain; --worker cannot be used. Run list-targets for available raw targets.",
    );
  }
  const worker = await discovery.waitFor((workers) => workerId === undefined
    ? (workerIndex === undefined ? undefined : workers[workerIndex])
    : workers.find((candidate) => candidate.workerId === workerId));
  if (worker === undefined) {
    const workers = discovery.list();
    const selector = workerId === undefined
      ? `index ${(workerIndex ?? 0).toString()}`
      : `workerId ${JSON.stringify(workerId)}`;
    throw new CfInspectorError(
      "INSPECTOR_DISCOVERY_FAILED",
      `No NodeWorker sub-session with ${selector} is currently attached (available: ${workers.length.toString()}). Ensure the worker is alive, then rerun list-targets.`,
    );
  }
  const client = await createNodeWorkerClient(parent, worker.sessionId);
  const session = await initSession(client, workerToInspectorTarget(worker), {
    kind: "worker",
    workerId: worker.workerId,
  });
  return withWorkerMetadata(session, discovery, targetIndex, targetCount, workerIndex, parent);
}

export async function connectInspectorGroup(
  options: Omit<InspectorConnectOptions, "workerIndex" | "workerId">,
): Promise<InspectorSessionGroup> {
  const host = options.host ?? DEFAULT_HOST;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const targets = await discoverInspectorTargets(host, options.port, connectTimeoutMs);
  const targetIndex = options.targetIndex ?? 0;
  const target = targets[targetIndex];
  if (target === undefined) {
    throw new CfInspectorError(
      "INSPECTOR_DISCOVERY_FAILED",
      `No inspector target at index ${targetIndex.toString()} on ${host}:${options.port.toString()} (available: ${targets.length.toString()})`,
    );
  }
  const parent = await CdpClient.connect({ url: target.webSocketDebuggerUrl, connectTimeoutMs });
  let discovery: NodeWorkerDiscovery | undefined;
  try {
    discovery = await startNodeWorkerDiscovery(parent);
    const main = await initSession(parent, target, { kind: "main" });
    const group = new DynamicInspectorSessionGroup(
      parent,
      discovery,
      main,
      targetIndex,
      targets.length,
    );
    await group.initialize();
    return group;
  } catch (error: unknown) {
    await discovery?.dispose();
    parent.dispose();
    throw error;
  }
}

class DynamicInspectorSessionGroup implements InspectorSessionGroup {
  private readonly sessions = new Map<string, InspectorSession>();
  private readonly listeners = new Set<(session: InspectorSession) => void>();
  private readonly removedListeners = new Set<(session: InspectorSession) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly pending = new Set<Promise<void>>();
  private readonly detachedSessionIds = new Set<string>();
  private readonly detachDiscoveryListeners: readonly (() => void)[];
  private initializationError: Error | undefined;
  private initializing = true;
  private disposed = false;

  public readonly workerDiscoverySupported: boolean;

  public constructor(
    private readonly parent: CdpClient,
    private readonly discovery: NodeWorkerDiscovery,
    main: InspectorSession,
    public readonly targetIndex: number,
    public readonly targetCount: number,
  ) {
    this.workerDiscoverySupported = discovery.supported;
    this.sessions.set("main", main);
    this.detachDiscoveryListeners = [
      discovery.onAttached((worker) => {
        this.queueWorker(worker);
      }),
      discovery.onDetached((sessionId) => {
        void this.detachWorker(sessionId);
      }),
    ];
  }

  public async initialize(): Promise<void> {
    for (const worker of this.discovery.list()) {
      this.queueWorker(worker);
    }
    await this.waitForPending();
    this.initializing = false;
    if (this.initializationError !== undefined) {
      throw this.initializationError;
    }
  }

  public list(): readonly InspectorSession[] {
    return [...this.sessions.values()];
  }

  public onSession(listener: (session: InspectorSession) => void): () => void {
    this.listeners.add(listener);
    for (const session of this.sessions.values()) {
      listener(session);
    }
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  public onSessionRemoved(listener: (session: InspectorSession) => void): () => void {
    this.removedListeners.add(listener);
    return (): void => {
      this.removedListeners.delete(listener);
    };
  }

  public onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return (): void => {
      this.errorListeners.delete(listener);
    };
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const detach of this.detachDiscoveryListeners) {
      detach();
    }
    await Promise.allSettled([...this.pending]);
    const sessions = [...this.list()].reverse();
    for (const session of sessions) {
      try {
        await session.dispose();
      } catch {
        // Continue closing every remaining session and the parent transport.
      }
    }
    this.sessions.clear();
    this.listeners.clear();
    this.removedListeners.clear();
    this.errorListeners.clear();
    await this.discovery.dispose();
    this.parent.dispose();
  }

  private queueWorker(worker: InspectorWorkerTarget): void {
    if (this.disposed || this.sessions.has(worker.sessionId)) {
      return;
    }
    const pending = this.attachWorker(worker).catch((error: unknown) => {
      const normalized = error instanceof Error ? error : new Error("Worker inspector attachment failed");
      if (this.initializing && this.initializationError === undefined) {
        this.initializationError = normalized;
      }
      for (const listener of this.errorListeners) {
        listener(normalized);
      }
    }).finally(() => {
      this.pending.delete(pending);
    });
    this.pending.add(pending);
  }

  private async attachWorker(worker: InspectorWorkerTarget): Promise<void> {
    const client = await createNodeWorkerClient(this.parent, worker.sessionId);
    try {
      const session = await initSession(client, workerToInspectorTarget(worker), {
        kind: "worker",
        workerId: worker.workerId,
      });
      if (this.disposed || this.detachedSessionIds.delete(worker.sessionId)) {
        await session.dispose();
        return;
      }
      this.sessions.set(worker.sessionId, session);
      for (const listener of this.listeners) {
        listener(session);
      }
    } catch (error: unknown) {
      client.dispose();
      if (!this.disposed) {
        throw error;
      }
    }
  }

  private async detachWorker(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      this.detachedSessionIds.add(sessionId);
      return;
    }
    this.sessions.delete(sessionId);
    for (const listener of this.removedListeners) {
      listener(session);
    }
    await session.dispose();
  }

  private async waitForPending(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }
}

function withWorkerMetadata(
  session: InspectorSession,
  discovery: NodeWorkerDiscovery,
  targetIndex: number,
  targetCount: number,
  workerIndex?: number,
  parent?: CdpClient,
): InspectorSession {
  return {
    ...session,
    targetIndex,
    targetCount,
    ...(workerIndex === undefined ? {} : { workerIndex }),
    workerTargets: discovery.list(),
    workerDiscoverySupported: discovery.supported,
    dispose: async (): Promise<void> => {
      await session.dispose();
      await discovery.dispose();
      parent?.dispose();
    },
  };
}

function workerToInspectorTarget(worker: InspectorWorkerTarget): InspectorTarget {
  return {
    description: "Node worker sub-session",
    id: worker.workerId,
    title: worker.title,
    type: worker.type,
    url: worker.url,
    webSocketDebuggerUrl: `node-worker://${worker.sessionId}`,
  };
}

export interface NodeWorkerTargetsResult {
  readonly supported: boolean;
  readonly workers: readonly InspectorWorkerTarget[];
}

export async function discoverNodeWorkerTargets(
  target: InspectorTarget,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<NodeWorkerTargetsResult> {
  const client = await CdpClient.connect({ url: target.webSocketDebuggerUrl, connectTimeoutMs });
  let discovery: NodeWorkerDiscovery | undefined;
  try {
    discovery = await startNodeWorkerDiscovery(client);
    return { supported: discovery.supported, workers: discovery.list() };
  } finally {
    await discovery?.dispose();
    client.dispose();
  }
}

async function initSession(
  client: CdpClient,
  target: InspectorSession["target"],
  isolate: NonNullable<InspectorSession["isolate"]>,
): Promise<InspectorSession> {
  const scripts = new Map<string, ScriptInfo>();
  registerScriptTracking(client, scripts);
  const pauseBuffer: PauseEvent[] = [];
  const pauseWaitGate = { active: false };
  const debuggerState: DebuggerState = { paused: false };
  registerPauseTracking(client, scripts, pauseBuffer, pauseWaitGate, debuggerState);
  await client.send("Runtime.enable");
  await client.send("Debugger.enable");
  return createSession(client, target, isolate, scripts, pauseBuffer, pauseWaitGate, debuggerState);
}

function registerScriptTracking(client: CdpClient, scripts: Map<string, ScriptInfo>): void {
  client.on("Debugger.scriptParsed", (raw) => {
    const script = toScriptInfo(raw);
    if (script !== undefined) {
      scripts.set(script.scriptId, script);
    }
  });
}

function registerPauseTracking(
  client: CdpClient,
  scripts: ReadonlyMap<string, ScriptInfo>,
  pauseBuffer: PauseEvent[],
  pauseWaitGate: { active: boolean },
  debuggerState: DebuggerState,
): void {
  client.on("Debugger.paused", (raw) => {
    const event = toPauseEvent(raw, performance.now(), scripts);
    debuggerState.paused = true;
    debuggerState.currentPause = event;
    if (pauseWaitGate.active) {
      return;
    }
    if (pauseBuffer.length >= PAUSE_BUFFER_LIMIT) {
      pauseBuffer.shift();
    }
    pauseBuffer.push(event);
  });
  client.on("Debugger.resumed", () => {
    debuggerState.paused = false;
    delete debuggerState.currentPause;
    debuggerState.lastResumedAtMs = performance.now();
  });
}

function createSession(
  client: CdpClient,
  target: InspectorSession["target"],
  isolate: NonNullable<InspectorSession["isolate"]>,
  scripts: ReadonlyMap<string, ScriptInfo>,
  pauseBuffer: PauseEvent[],
  pauseWaitGate: { active: boolean },
  debuggerState: DebuggerState,
): InspectorSession {
  return {
    client,
    target,
    isolate,
    scripts,
    pauseBuffer,
    pauseWaitGate,
    debuggerState,
    dispose: async (): Promise<void> => {
      try {
        await client.send("Debugger.disable");
      } catch {
        // best-effort
      }
      client.dispose();
    },
  };
}

export const internalsForTesting = {
  startNodeWorkerDiscovery,
};
