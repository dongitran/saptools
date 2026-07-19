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
  InspectorWorkerTarget,
} from "./types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_HOST = "127.0.0.1";
const PAUSE_BUFFER_LIMIT = 32;

export class NodeWorkerDiscovery {
  private readonly workers = new Map<string, InspectorWorkerTarget>();
  private readonly detachListeners: readonly (() => void)[];
  public supported = false;
  private disposed = false;

  public constructor(private readonly client: CdpClient) {
    this.detachListeners = [
      client.on("NodeWorker.attachedToWorker", (raw) => {
        const worker = toInspectorWorkerTarget(raw);
        if (worker !== undefined) {
          this.workers.set(worker.sessionId, worker);
        }
      }),
      client.on("NodeWorker.detachedFromWorker", (raw) => {
        const sessionId = readField(raw, "sessionId");
        if (typeof sessionId === "string") {
          this.workers.delete(sessionId);
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
    if (options.workerIndex === undefined) {
      const session = await initSession(client, target);
      return withWorkerMetadata(session, workerDiscovery, targetIndex, targets.length);
    }
    return await initWorkerSession(
      client,
      workerDiscovery,
      options.workerIndex,
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
  workerIndex: number,
  targetIndex: number,
  targetCount: number,
): Promise<InspectorSession> {
  const workers = discovery.list();
  if (!discovery.supported) {
    throw new CfInspectorError(
      "INSPECTOR_DISCOVERY_FAILED",
      "This runtime does not expose the NodeWorker CDP domain; --worker cannot be used. Run list-targets for available raw targets.",
    );
  }
  const worker = workers[workerIndex];
  if (worker === undefined) {
    throw new CfInspectorError(
      "INSPECTOR_DISCOVERY_FAILED",
      `No NodeWorker sub-session at index ${workerIndex.toString()} (available: ${workers.length.toString()}). Ensure the worker is alive, then rerun list-targets.`,
    );
  }
  const client = await createNodeWorkerClient(parent, worker.sessionId);
  const session = await initSession(client, workerToInspectorTarget(worker));
  return withWorkerMetadata(session, discovery, targetIndex, targetCount, workerIndex, parent);
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
): Promise<InspectorSession> {
  const scripts = new Map<string, ScriptInfo>();
  registerScriptTracking(client, scripts);
  const pauseBuffer: PauseEvent[] = [];
  const pauseWaitGate = { active: false };
  const debuggerState: DebuggerState = {};
  registerPauseTracking(client, scripts, pauseBuffer, pauseWaitGate, debuggerState);
  await client.send("Runtime.enable");
  await client.send("Debugger.enable");
  return createSession(client, target, scripts, pauseBuffer, pauseWaitGate, debuggerState);
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
    if (pauseWaitGate.active) {
      return;
    }
    const event = toPauseEvent(raw, performance.now(), scripts);
    if (pauseBuffer.length >= PAUSE_BUFFER_LIMIT) {
      pauseBuffer.shift();
    }
    pauseBuffer.push(event);
  });
  client.on("Debugger.resumed", () => {
    debuggerState.lastResumedAtMs = performance.now();
  });
}

function createSession(
  client: CdpClient,
  target: InspectorSession["target"],
  scripts: ReadonlyMap<string, ScriptInfo>,
  pauseBuffer: PauseEvent[],
  pauseWaitGate: { active: boolean },
  debuggerState: DebuggerState,
): InspectorSession {
  return {
    client,
    target,
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
