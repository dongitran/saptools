export type LiveTraceLifecycleState =
  | "idle"
  | "preparing"
  | "enabling-ssh"
  | "starting-inspector"
  | "opening-tunnel"
  | "injecting"
  | "streaming"
  | "stopping"
  | "stopped"
  | "error";

export type LiveTraceStopReason = "user" | "duration" | "max-events" | "error" | "shutdown";

export interface CfLiveTraceTarget {
  readonly apiEndpoint?: string;
  readonly region?: string;
  readonly email: string;
  readonly password: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
  readonly instanceIndex?: number;
  readonly cfHomeDir?: string;
  readonly command?: string;
}

export interface LiveTraceStartOptions {
  readonly captureHeaders?: boolean;
  readonly captureRequestBody?: boolean;
  readonly captureResponseBody?: boolean;
  readonly maxBodyBytes?: number;
  readonly runtimeQueueSize?: number;
}

export interface LiveTraceStateEvent {
  readonly state: LiveTraceLifecycleState;
  readonly app: string;
  readonly instance: string;
  readonly message: string;
  readonly runtimeHookInstalled: boolean;
  readonly runtimeHookMayRemain: boolean;
}

export interface LiveTraceEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly appId: string;
  readonly instance: string;
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly normalizedUrl: string;
  readonly status: number | null;
  readonly durationMs: number | null;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly requestHeaders: Record<string, string>;
  readonly responseHeaders: Record<string, string>;
  readonly requestBodyPreview: string;
  readonly responseBodyPreview: string;
  readonly requestBodyTruncated: boolean;
  readonly responseBodyTruncated: boolean;
  readonly droppedBeforeEvent: number;
  readonly source: "runtime-http";
  readonly traceId: string;
  readonly correlationId: string | null;
}

export interface LiveTraceUrlSummary {
  readonly normalizedUrl: string;
  readonly displayUrl: string;
  readonly methods: readonly string[];
  readonly totalCount: number;
  readonly statusCounts: {
    readonly "2xx": number;
    readonly "3xx": number;
    readonly "4xx": number;
    readonly "5xx": number;
    readonly unknown: number;
  };
  readonly latestStatus: number | null;
  readonly latestDurationMs: number | null;
  readonly latestSeenAt: string;
}

export interface DrainParseResult {
  readonly drainId: string | null;
  readonly events: readonly LiveTraceEvent[];
  readonly droppedCount: number;
  readonly queueSize: number;
}

export interface InspectorRuntimeClient {
  evaluate(expression: string, timeoutMs: number): Promise<unknown>;
  close(): Promise<void> | void;
}

export type InspectorStartupResult =
  | {
    readonly status: "ready";
    readonly detail?: string;
  }
  | {
    readonly status: "not-ready";
    readonly detail?: string;
  };

export interface PortForwardProcess {
  once(event: "exit" | "error", listener: () => void): this;
  removeListener(event: "exit" | "error", listener: () => void): this;
}

export interface PortForwardHandle {
  readonly process: PortForwardProcess;
  readonly localPort: number;
  stop(): void;
}

export interface TunnelReadyResult {
  readonly status: "ready";
  readonly handle: Pick<PortForwardHandle, "localPort" | "stop">;
}

export type TunnelOpenResult = TunnelReadyResult | { readonly status: "not-reachable" };

export interface LiveTraceStopOptions {
  readonly uninstallRuntimeHook: boolean;
  readonly reason: LiveTraceStopReason;
}
