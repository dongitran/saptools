import { startDebugger } from "@saptools/cf-debugger";
import type { DebuggerHandle, SessionStatus, StartDebuggerOptions } from "@saptools/cf-debugger";

export interface TunnelTarget {
  readonly region: string;
  readonly apiEndpoint?: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
  readonly tunnelReadyTimeoutMs?: number;
  readonly preferredPort?: number;
  readonly verbose?: boolean;
  readonly signal?: AbortSignal;
  readonly onStatus?: (status: SessionStatus, message?: string) => void;
}

export interface OpenedTunnel {
  readonly localPort: number;
  readonly handle?: DebuggerHandle;
  dispose(): Promise<void>;
}

export async function openCfTunnel(target: TunnelTarget): Promise<OpenedTunnel> {
  const opts: StartDebuggerOptions = {
    region: target.region,
    ...(target.apiEndpoint === undefined ? {} : { apiEndpoint: target.apiEndpoint }),
    org: target.org,
    space: target.space,
    app: target.app,
    ...(target.tunnelReadyTimeoutMs === undefined ? {} : { tunnelReadyTimeoutMs: target.tunnelReadyTimeoutMs }),
    ...(target.preferredPort === undefined ? {} : { preferredPort: target.preferredPort }),
    ...(target.verbose === undefined ? {} : { verbose: target.verbose }),
    ...(target.signal === undefined ? {} : { signal: target.signal }),
    ...(target.onStatus === undefined ? {} : { onStatus: target.onStatus }),
  };
  try {
    const handle = await startDebugger(opts);
    return {
      localPort: handle.session.localPort,
      handle,
      dispose: async (): Promise<void> => {
        await handle.dispose();
      },
    };
  } catch (err: unknown) {
    return reuseExistingTunnelOrThrow(err, target.onStatus);
  }
}

function reuseExistingTunnelOrThrow(
  err: unknown,
  onStatus: TunnelTarget["onStatus"],
): OpenedTunnel {
  if (!isSessionAlreadyRunningError(err)) {
    throw err;
  }
  const message = err instanceof Error ? err.message : String(err);
  const port = extractExistingTunnelPort(message);
  if (port === undefined) {
    throw err;
  }
  const warning = `Reusing existing tunnel on port ${port.toString()}`;
  onStatus?.("ready", warning);
  return {
    localPort: port,
    dispose: (): Promise<void> => Promise.resolve(),
  };
}

function isSessionAlreadyRunningError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const code = (err as { readonly code?: unknown }).code;
  return code === "SESSION_ALREADY_RUNNING";
}

function extractExistingTunnelPort(message: string): number | undefined {
  const match = /on port (\d+)/i.exec(message);
  if (match === null) {
    return undefined;
  }
  const rawPort = match[1];
  if (rawPort === undefined) {
    return undefined;
  }
  const port = Number.parseInt(rawPort, 10);
  return Number.isNaN(port) ? undefined : port;
}
