import { TraceDataError } from "./errors.js";
import type { ProcessGuard } from "./process-guard.js";

export interface DisposableInspectorSession {
  dispose(): Promise<void>;
}

export interface LocalTraceTarget {
  readonly kind: "local";
  readonly host: string;
  readonly port: number;
  readonly targetIndex?: number;
  readonly workerIndex?: number;
}

export interface CfTraceTarget {
  readonly kind: "cf";
  readonly region: string;
  readonly apiEndpoint?: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
  readonly process: string;
  readonly instance: number;
  readonly nodePid?: number;
  readonly preferredPort?: number;
  readonly targetIndex?: number;
  readonly workerIndex?: number;
  readonly confirmImpact: boolean;
}

export type TraceTarget = LocalTraceTarget | CfTraceTarget;

export interface InspectorConnectInput {
  readonly host: string;
  readonly port: number;
  readonly targetIndex?: number;
  readonly workerIndex?: number;
}

export interface TunnelOpenInput {
  readonly region: string;
  readonly apiEndpoint?: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
  readonly process: string;
  readonly instance: number;
  readonly nodePid?: number;
  readonly preferredPort?: number;
  readonly allowSshEnableRestart: boolean;
  readonly signal?: AbortSignal;
}

export interface OpenedTraceTunnel {
  readonly localPort: number;
  dispose(): Promise<void>;
}

export interface TraceSessionDependencies<TSession extends DisposableInspectorSession> {
  connectInspector(input: InspectorConnectInput): Promise<TSession>;
  openCfTunnel(input: TunnelOpenInput): Promise<OpenedTraceTunnel>;
}

interface ResolvedEndpoint {
  readonly host: string;
  readonly port: number;
  dispose(): Promise<void>;
}

type SessionOutcome<TResult> =
  | { readonly ok: true; readonly value: TResult }
  | { readonly ok: false; readonly error: unknown };

function safeTunnelError(error: unknown): TraceDataError | undefined {
  const code: unknown = typeof error === "object" && error !== null
    ? Reflect.get(error, "code")
    : undefined;
  if (code !== "SSH_NOT_ENABLED") {
    return undefined;
  }
  return new TraceDataError(
    "SSH_NOT_ENABLED",
    "Cloud Foundry SSH is not enabled for the selected app; enable it explicitly before tracing.",
    undefined,
    error,
  );
}

function localEndpoint(target: LocalTraceTarget): ResolvedEndpoint {
  return {
    host: target.host,
    port: target.port,
    dispose: (): Promise<void> => Promise.resolve(),
  };
}

function tunnelInput(target: CfTraceTarget, signal: AbortSignal | undefined): TunnelOpenInput {
  return {
    region: target.region,
    ...(target.apiEndpoint === undefined ? {} : { apiEndpoint: target.apiEndpoint }),
    org: target.org,
    space: target.space,
    app: target.app,
    process: target.process,
    instance: target.instance,
    ...(target.nodePid === undefined ? {} : { nodePid: target.nodePid }),
    ...(target.preferredPort === undefined ? {} : { preferredPort: target.preferredPort }),
    allowSshEnableRestart: false,
    ...(signal === undefined ? {} : { signal }),
  };
}

async function remoteEndpoint<TSession extends DisposableInspectorSession>(
  target: CfTraceTarget,
  dependencies: TraceSessionDependencies<TSession>,
  signal?: AbortSignal,
): Promise<ResolvedEndpoint> {
  if (!target.confirmImpact) {
    throw new TraceDataError(
      "REMOTE_IMPACT_NOT_CONFIRMED",
      "Remote tracing pauses application execution; pass --confirm-impact to continue.",
    );
  }
  let tunnel: OpenedTraceTunnel;
  try {
    tunnel = await dependencies.openCfTunnel(tunnelInput(target, signal));
  } catch (error: unknown) {
    if (isAbortError(error) || signal?.aborted === true) {
      throw new TraceDataError("TRACE_ABORTED", "Tracing was aborted while opening the CF tunnel.");
    }
    const mappedError = safeTunnelError(error);
    if (mappedError !== undefined) {
      throw mappedError;
    }
    throw error;
  }
  return {
    host: "127.0.0.1",
    port: tunnel.localPort,
    dispose: async (): Promise<void> => {
      await tunnel.dispose();
    },
  };
}

async function resolveEndpoint<TSession extends DisposableInspectorSession>(
  target: TraceTarget,
  dependencies: TraceSessionDependencies<TSession>,
  signal?: AbortSignal,
): Promise<ResolvedEndpoint> {
  if (signal?.aborted === true) {
    throw new TraceDataError("TRACE_ABORTED", "Tracing was aborted before opening the inspector session.");
  }
  return target.kind === "local"
    ? localEndpoint(target)
    : await remoteEndpoint(target, dependencies, signal);
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ABORTED";
}

function selectionInput(target: TraceTarget): {
  readonly targetIndex?: number;
  readonly workerIndex?: number;
} {
  return {
    ...(target.targetIndex === undefined ? {} : { targetIndex: target.targetIndex }),
    ...(target.workerIndex === undefined ? {} : { workerIndex: target.workerIndex }),
  };
}

async function cleanupSession(
  session: DisposableInspectorSession | undefined,
  endpoint: ResolvedEndpoint,
): Promise<readonly unknown[]> {
  const errors: unknown[] = [];
  try {
    await session?.dispose();
  } catch (error: unknown) {
    errors.push(error);
  }
  try {
    await endpoint.dispose();
  } catch (error: unknown) {
    errors.push(error);
  }
  return errors;
}

function completeOutcome<TResult>(
  outcome: SessionOutcome<TResult>,
  cleanupErrors: readonly unknown[],
): TResult {
  if (cleanupErrors.length > 0) {
    const causes = outcome.ok ? cleanupErrors : [outcome.error, ...cleanupErrors];
    throw new TraceDataError(
      "CLEANUP_FAILED",
      "The trace session could not be cleaned up safely.",
      undefined,
      new AggregateError(causes, "Trace session operation or cleanup failed."),
    );
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

export async function withTraceSession<
  TSession extends DisposableInspectorSession,
  TResult,
>(
  target: TraceTarget,
  callback: (session: TSession) => Promise<TResult>,
  dependencies: TraceSessionDependencies<TSession>,
  signal?: AbortSignal,
  guard?: ProcessGuard,
): Promise<TResult> {
  const endpoint = await resolveEndpoint(target, dependencies, signal);
  // Registered as soon as the tunnel exists so an emergency shutdown can
  // kill the owned `cf ssh` child even if the process dies before this
  // function's own cleanup below gets a chance to run.
  const unregisterTunnel = guard?.register({
    label: "cf-ssh-tunnel",
    release: async (): Promise<void> => {
      await endpoint.dispose();
    },
  });
  let session: TSession | undefined;
  let unregisterSession: (() => void) | undefined;
  let outcome: SessionOutcome<TResult>;
  try {
    if (signal?.aborted === true) {
      throw new TraceDataError("TRACE_ABORTED", "Tracing was aborted before connecting to the inspector.");
    }
    session = await dependencies.connectInspector({
      host: endpoint.host,
      port: endpoint.port,
      ...selectionInput(target),
    });
    unregisterSession = guard?.register({
      label: "inspector-session",
      release: async (): Promise<void> => {
        await session?.dispose();
      },
    });
    outcome = { ok: true, value: await callback(session) };
  } catch (error: unknown) {
    outcome = { ok: false, error };
  }
  const cleanupErrors = await cleanupSession(session, endpoint);
  unregisterSession?.();
  unregisterTunnel?.();
  return completeOutcome(outcome, cleanupErrors);
}
