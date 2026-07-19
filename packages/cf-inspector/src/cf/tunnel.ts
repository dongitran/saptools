import { startDebugger } from "@saptools/cf-debugger";
import type { DebuggerHandle, SessionStatus, StartDebuggerOptions } from "@saptools/cf-debugger";

export interface TunnelTarget {
  readonly region: string;
  readonly apiEndpoint?: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
  readonly process?: string;
  readonly instance?: number;
  readonly nodePid?: number;
  readonly allowSshEnableRestart?: boolean;
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

function targetOptions(
  target: TunnelTarget,
): Pick<StartDebuggerOptions, "apiEndpoint" | "process" | "instance" | "nodePid"> {
  return {
    ...(target.apiEndpoint === undefined ? {} : { apiEndpoint: target.apiEndpoint }),
    ...(target.process === undefined ? {} : { process: target.process }),
    ...(target.instance === undefined ? {} : { instance: target.instance }),
    ...(target.nodePid === undefined ? {} : { nodePid: target.nodePid }),
  };
}

function lifecycleOptions(
  target: TunnelTarget,
): Pick<
  StartDebuggerOptions,
  "allowSshEnableRestart" | "tunnelReadyTimeoutMs" | "preferredPort" | "verbose" | "signal" | "onStatus"
> {
  return {
    ...(target.allowSshEnableRestart === undefined ? {} : { allowSshEnableRestart: target.allowSshEnableRestart }),
    ...(target.tunnelReadyTimeoutMs === undefined ? {} : { tunnelReadyTimeoutMs: target.tunnelReadyTimeoutMs }),
    ...(target.preferredPort === undefined ? {} : { preferredPort: target.preferredPort }),
    ...(target.verbose === undefined ? {} : { verbose: target.verbose }),
    ...(target.signal === undefined ? {} : { signal: target.signal }),
    ...(target.onStatus === undefined ? {} : { onStatus: target.onStatus }),
  };
}

function toStartDebuggerOptions(target: TunnelTarget): StartDebuggerOptions {
  return {
    region: target.region,
    org: target.org,
    space: target.space,
    app: target.app,
    ...targetOptions(target),
    ...lifecycleOptions(target),
  };
}

export async function openOwnedCfTunnel(target: TunnelTarget): Promise<OpenedTunnel> {
  const opts = toStartDebuggerOptions(target);
  const handle = await startDebugger(opts);
  return {
    localPort: handle.session.localPort,
    handle,
    dispose: async (): Promise<void> => {
      await handle.dispose();
    },
  };
}

function isExistingSessionError(error: unknown): error is Error & { readonly code: "SESSION_ALREADY_RUNNING" } {
  return error instanceof Error
    && "code" in error
    && error.code === "SESSION_ALREADY_RUNNING";
}

function existingTunnelPort(error: unknown): number | undefined {
  if (!isExistingSessionError(error)) {
    return undefined;
  }
  const rawPort = /\bon port (\d+)\b/iu.exec(error.message)?.[1];
  if (rawPort === undefined) {
    return undefined;
  }
  const port = Number.parseInt(rawPort, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

export async function openCfTunnel(target: TunnelTarget): Promise<OpenedTunnel> {
  try {
    return await openOwnedCfTunnel(target);
  } catch (error: unknown) {
    const localPort = existingTunnelPort(error);
    if (localPort === undefined) {
      throw error;
    }
    target.onStatus?.("ready", `Reusing existing tunnel on port ${localPort.toString()}`);
    return { localPort, dispose: (): Promise<void> => Promise.resolve() };
  }
}
