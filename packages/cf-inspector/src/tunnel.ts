import { startDebugger } from "@saptools/cf-debugger";
import type { DebuggerHandle, StartDebuggerOptions } from "@saptools/cf-debugger";

export interface TunnelTarget {
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
  readonly tunnelReadyTimeoutMs?: number;
  readonly preferredPort?: number;
  readonly verbose?: boolean;
  readonly signal?: AbortSignal;
}

export interface OpenedTunnel {
  readonly localPort: number;
  readonly handle: DebuggerHandle;
  dispose(): Promise<void>;
}

export async function openCfTunnel(target: TunnelTarget): Promise<OpenedTunnel> {
  const opts: StartDebuggerOptions = {
    region: target.region,
    org: target.org,
    space: target.space,
    app: target.app,
    ...(target.tunnelReadyTimeoutMs === undefined ? {} : { tunnelReadyTimeoutMs: target.tunnelReadyTimeoutMs }),
    ...(target.preferredPort === undefined ? {} : { preferredPort: target.preferredPort }),
    ...(target.verbose === undefined ? {} : { verbose: target.verbose }),
    ...(target.signal === undefined ? {} : { signal: target.signal }),
  };
  const handle = await startDebugger(opts);
  return {
    localPort: handle.session.localPort,
    handle,
    dispose: async (): Promise<void> => {
      await handle.dispose();
    },
  };
}
