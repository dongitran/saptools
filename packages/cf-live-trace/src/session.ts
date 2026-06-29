import { ensureSshEnabled, openInspectorTunnel, prepareCfSession, startNodeInspector } from "./cf.js";
import { connectRuntimeInspector } from "./inspector.js";
import { parseDrainResult } from "./payload.js";
import { buildDrainExpression, buildInstallExpression, buildStopExpression } from "./runtime-source.js";
import { buildUrlSummaries } from "./summary.js";
import type {
  CfLiveTraceTarget,
  InspectorStartupResult,
  InspectorRuntimeClient,
  LiveTraceEvent,
  LiveTraceStartOptions,
  LiveTraceStateEvent,
  LiveTraceStopOptions,
  TunnelOpenResult,
} from "./types.js";

export interface LiveTraceSessionOptions {
  readonly target: CfLiveTraceTarget;
  readonly onState?: (event: LiveTraceStateEvent) => void;
  readonly onEvents?: (events: readonly LiveTraceEvent[]) => void;
  readonly onSummary?: (summary: ReturnType<typeof buildUrlSummaries>) => void;
  readonly onLog?: (message: string) => void;
}

export interface LiveTraceDependencies {
  prepareCfSession(target: CfLiveTraceTarget): Promise<void>;
  ensureSshEnabled(target: CfLiveTraceTarget): Promise<void>;
  tryStartNodeInspector(target: CfLiveTraceTarget): Promise<boolean | InspectorStartupResult>;
  openInspectorTunnel(target: CfLiveTraceTarget): Promise<TunnelOpenResult>;
  connectInspector(localPort: number): Promise<InspectorRuntimeClient>;
  setInterval(callback: () => void, ms: number): NodeJS.Timeout;
  clearInterval(handle: NodeJS.Timeout): void;
}

const DRAIN_INTERVAL_MS = 250;
const DRAIN_BATCH_SIZE = 50;
const RUNTIME_QUEUE_SIZE = 1000;
const CONTROL_EVALUATE_TIMEOUT_MS = 5000;
const DRAIN_EVALUATE_TIMEOUT_MS = 10000;
const DRAIN_TIMEOUT_RETRY_LIMIT = 3;
const DRAIN_TRANSPORT_BODY_LIMIT = 20_000;

const defaultDependencies: LiveTraceDependencies = {
  prepareCfSession,
  ensureSshEnabled,
  tryStartNodeInspector: startNodeInspector,
  openInspectorTunnel,
  connectInspector: connectRuntimeInspector,
  setInterval,
  clearInterval,
};

export class LiveTraceSession {
  private readonly dependencies: LiveTraceDependencies;
  private readonly events: LiveTraceEvent[] = [];
  private consecutiveDrainTimeouts = 0;
  private drainInFlight = false;
  private inspectorClient: InspectorRuntimeClient | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private state: LiveTraceStateEvent["state"] = "idle";
  private stopRequested = false;
  private tunnelHandle: { readonly localPort: number; readonly stop: () => void } | undefined;

  public constructor(
    private readonly options: LiveTraceSessionOptions,
    dependencies: Partial<LiveTraceDependencies> = {},
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  public async start(options: LiveTraceStartOptions = {}): Promise<void> {
    if (this.isRunning()) {
      return;
    }
    this.stopRequested = false;
    await this.startRuntimeTrace(resolveStartOptions(options));
  }

  public async stop(options: LiveTraceStopOptions): Promise<void> {
    this.stopRequested = true;
    if (!this.isRunning()) {
      if (this.state === "error" && options.reason === "error") {
        return;
      }
      this.postState("stopped", `Trace stopped (${options.reason}).`, false, false);
      return;
    }
    const hadRuntimeHook = this.inspectorClient !== undefined;
    this.postState("stopping", `Stopping trace (${options.reason}).`, hadRuntimeHook, hadRuntimeHook);
    const uninstalled = await this.stopRuntimeTrace(options.uninstallRuntimeHook);
    this.postState("stopped", `Trace stopped (${options.reason}).`, false, hadRuntimeHook && !uninstalled);
  }

  public isRunning(): boolean {
    return ["preparing", "enabling-ssh", "starting-inspector", "opening-tunnel", "injecting", "streaming", "stopping"].includes(this.state);
  }

  private async startRuntimeTrace(options: Required<LiveTraceStartOptions>): Promise<void> {
    try {
      this.postState("preparing", "Preparing Cloud Foundry session.", false, false);
      await this.dependencies.prepareCfSession(this.options.target);
      if (this.shouldStop()) {
        return;
      }
      await this.startInspector(options);
    } catch (error) {
      this.log(`Live Trace startup failed for ${this.options.target.app}: ${formatError(error)}`);
      await this.stopRuntimeTrace(false);
      const startupError = toStartupError(error);
      if (!this.shouldStop()) {
        this.postState("error", startupError.stateMessage, false, false);
      }
      throw startupError;
    }
  }

  private async startInspector(options: Required<LiveTraceStartOptions>): Promise<void> {
    this.postState("enabling-ssh", "Ensuring CF SSH access.", false, false);
    await this.dependencies.ensureSshEnabled(this.options.target);
    if (this.shouldStop()) {
      return;
    }
    this.postState("starting-inspector", "Requesting Node Inspector startup.", false, false);
    this.reportInspectorStartup(await this.dependencies.tryStartNodeInspector(this.options.target));
    if (this.shouldStop()) {
      return;
    }
    this.postState("opening-tunnel", "Opening Node Inspector tunnel.", false, false);
    const tunnel = await this.dependencies.openInspectorTunnel(this.options.target);
    await this.attachInspector(tunnel, options);
  }

  private async attachInspector(tunnel: TunnelOpenResult, options: Required<LiveTraceStartOptions>): Promise<void> {
    if (this.shouldStop()) {
      stopLateTunnel(tunnel);
      return;
    }
    if (tunnel.status !== "ready") {
      throw new LiveTraceStartupError(
        "Node Inspector is not reachable on 127.0.0.1:9229.",
        "Node Inspector is not reachable on 127.0.0.1:9229.",
      );
    }
    this.tunnelHandle = tunnel.handle;
    this.inspectorClient = await this.dependencies.connectInspector(tunnel.handle.localPort);
    this.postState("injecting", "Installing runtime HTTP trace hook.", false, false);
    await this.installRuntimeHook(options);
    this.startPolling(options.maxBodyBytes);
    this.postState("streaming", "Streaming runtime HTTP trace events.", true, false);
  }

  private async installRuntimeHook(options: Required<LiveTraceStartOptions>): Promise<void> {
    await this.requireInspector().evaluate(buildInstallExpression({
      appId: this.options.target.app,
      instance: String(this.options.target.instanceIndex ?? 0),
      captureHeaders: options.captureHeaders,
      captureRequestBody: options.captureRequestBody,
      captureResponseBody: options.captureResponseBody,
      maxBodyBytes: options.maxBodyBytes,
      maxEvents: options.runtimeQueueSize,
    }), CONTROL_EVALUATE_TIMEOUT_MS);
  }

  private startPolling(maxBodyBytes: number): void {
    this.stopPolling();
    this.consecutiveDrainTimeouts = 0;
    this.pollTimer = this.dependencies.setInterval(() => {
      void this.drainTraceEvents(maxBodyBytes);
    }, DRAIN_INTERVAL_MS);
  }

  private async drainTraceEvents(maxBodyBytes: number): Promise<void> {
    if (this.drainInFlight || this.inspectorClient === undefined || this.state !== "streaming") {
      return;
    }
    this.drainInFlight = true;
    try {
      const payload = await this.inspectorClient.evaluate(
        buildDrainExpression(DRAIN_BATCH_SIZE, resolveDrainTransportBodyLimit(maxBodyBytes)),
        DRAIN_EVALUATE_TIMEOUT_MS,
      );
      this.consecutiveDrainTimeouts = 0;
      this.publishDrainedEvents(payload, maxBodyBytes);
    } catch (error) {
      await this.handleDrainFailure(error);
    } finally {
      this.drainInFlight = false;
    }
  }

  private publishDrainedEvents(payload: unknown, maxBodyBytes: number): void {
    const drained = parseDrainResult(payload, { appId: this.options.target.app, maxBodyBytes });
    if (drained.events.length === 0) {
      return;
    }
    this.events.push(...drained.events);
    this.events.splice(0, Math.max(0, this.events.length - RUNTIME_QUEUE_SIZE));
    this.options.onEvents?.(drained.events);
    this.options.onSummary?.(buildUrlSummaries(this.events));
  }

  private async handleDrainFailure(error: unknown): Promise<void> {
    if (isEvaluateTimeout(error)) {
      this.consecutiveDrainTimeouts += 1;
      if (this.consecutiveDrainTimeouts < DRAIN_TIMEOUT_RETRY_LIMIT) {
        this.log(`Live Trace drain timed out for ${this.options.target.app}; retrying (${String(this.consecutiveDrainTimeouts)}/${String(DRAIN_TIMEOUT_RETRY_LIMIT)}).`);
        return;
      }
    }
    this.log(`Live Trace stream failed for ${this.options.target.app}: ${formatError(error)}`);
    await this.stopRuntimeTrace(false);
    this.postState("error", "Runtime HTTP trace connection was lost.", false, true);
  }

  private async stopRuntimeTrace(uninstallRuntimeHook: boolean): Promise<boolean> {
    this.stopPolling();
    this.consecutiveDrainTimeouts = 0;
    const uninstalled = await this.stopInspectorHook(uninstallRuntimeHook);
    await this.closeInspectorClient();
    this.stopTunnel();
    return uninstalled;
  }

  private async closeInspectorClient(): Promise<void> {
    const client = this.inspectorClient;
    this.inspectorClient = undefined;
    try {
      await client?.close();
    } catch (error) {
      this.log(`Live Trace inspector close failed for ${this.options.target.app}: ${formatError(error)}`);
    }
  }

  private stopTunnel(): void {
    const tunnel = this.tunnelHandle;
    this.tunnelHandle = undefined;
    try {
      tunnel?.stop();
    } catch (error) {
      this.log(`Live Trace tunnel cleanup failed for ${this.options.target.app}: ${formatError(error)}`);
    }
  }

  private async stopInspectorHook(uninstallRuntimeHook: boolean): Promise<boolean> {
    if (this.inspectorClient === undefined) {
      return true;
    }
    try {
      await this.inspectorClient.evaluate(buildStopExpression({ uninstallRuntimeHook }), CONTROL_EVALUATE_TIMEOUT_MS);
      return uninstallRuntimeHook;
    } catch (error) {
      this.log(`Live Trace cleanup failed for ${this.options.target.app}: ${formatError(error)}`);
      return false;
    }
  }

  private stopPolling(): void {
    if (this.pollTimer === undefined) {
      return;
    }
    this.dependencies.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private postState(state: LiveTraceStateEvent["state"], message: string, runtimeHookInstalled: boolean, runtimeHookMayRemain: boolean): void {
    this.state = state;
    this.options.onState?.({
      state,
      app: this.options.target.app,
      instance: String(this.options.target.instanceIndex ?? 0),
      message,
      runtimeHookInstalled,
      runtimeHookMayRemain,
    });
  }

  private requireInspector(): InspectorRuntimeClient {
    if (this.inspectorClient === undefined) {
      throw new Error("Inspector client is not connected.");
    }
    return this.inspectorClient;
  }

  private shouldStop(): boolean {
    return this.stopRequested;
  }

  private log(message: string): void {
    this.options.onLog?.(message);
  }

  private reportInspectorStartup(result: boolean | InspectorStartupResult): void {
    const normalized = normalizeInspectorStartupResult(result);
    if (normalized.status === "ready") {
      return;
    }
    const detail = normalized.detail === undefined ? "" : `: ${normalized.detail}`;
    this.log(`Node Inspector startup was not confirmed for ${this.options.target.app}${detail}`);
  }
}

class LiveTraceStartupError extends Error {
  public constructor(
    message: string,
    public readonly stateMessage: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

function resolveStartOptions(options: LiveTraceStartOptions): Required<LiveTraceStartOptions> {
  return {
    captureHeaders: options.captureHeaders ?? true,
    captureRequestBody: options.captureRequestBody ?? true,
    captureResponseBody: options.captureResponseBody ?? true,
    maxBodyBytes: options.maxBodyBytes ?? 4096,
    runtimeQueueSize: options.runtimeQueueSize ?? RUNTIME_QUEUE_SIZE,
  };
}

function stopLateTunnel(tunnel: TunnelOpenResult): void {
  if (tunnel.status === "ready") {
    tunnel.handle.stop();
  }
}

function resolveDrainTransportBodyLimit(maxBodyBytes: number): number {
  return maxBodyBytes > 0 ? Math.min(maxBodyBytes, DRAIN_TRANSPORT_BODY_LIMIT) : DRAIN_TRANSPORT_BODY_LIMIT;
}

function isEvaluateTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Runtime.evaluate timed out");
}

function toStartupError(error: unknown): LiveTraceStartupError {
  if (error instanceof LiveTraceStartupError) {
    return error;
  }
  return new LiveTraceStartupError(
    "Runtime HTTP trace could not be started.",
    "Runtime HTTP trace could not be started.",
    error,
  );
}

function normalizeInspectorStartupResult(result: boolean | InspectorStartupResult): InspectorStartupResult {
  return typeof result === "boolean"
    ? { status: result ? "ready" : "not-ready" }
    : result;
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().length > 0 ? message.trim() : "Unknown error";
}
