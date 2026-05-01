import { openCfTunnel } from "../cf/tunnel.js";
import { connectInspector } from "../inspector/session.js";
import type { InspectorSession } from "../inspector/types.js";
import { CfInspectorError } from "../types.js";

import { DEFAULT_CF_TIMEOUT_SEC } from "./commandTypes.js";
import type { SharedTargetOptions, Target } from "./commandTypes.js";

export function parsePositiveInt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value <= 0 || value.toString() !== raw.trim()) {
    throw new CfInspectorError("INVALID_ARGUMENT", `Invalid ${label}: "${raw}" — expected a positive integer`);
  }
  return value;
}

export function resolveTarget(opts: SharedTargetOptions): Target {
  const port = parsePositiveInt(opts.port, "--port");
  if (port !== undefined) {
    return { kind: "port", port, host: opts.host ?? "127.0.0.1" };
  }
  if (hasCfTarget(opts)) {
    const cfTimeoutSec = parsePositiveInt(opts.cfTimeout, "--cf-timeout") ?? DEFAULT_CF_TIMEOUT_SEC;
    return {
      kind: "cf",
      region: opts.region,
      org: opts.org,
      space: opts.space,
      app: opts.app,
      cfTimeoutMs: cfTimeoutSec * 1000,
    };
  }
  throw new CfInspectorError(
    "MISSING_TARGET",
    "Provide either --port (and optionally --host) or all of --region, --org, --space, --app.",
  );
}

function hasCfTarget(opts: SharedTargetOptions): opts is SharedTargetOptions & {
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
} {
  return (
    opts.region !== undefined &&
    opts.org !== undefined &&
    opts.space !== undefined &&
    opts.app !== undefined
  );
}

interface ResolvedTunnel {
  readonly port: number;
  readonly host: string;
  readonly dispose: () => Promise<void>;
}

export async function withSession<T>(
  target: Target,
  fn: (session: InspectorSession, port: number) => Promise<T>,
): Promise<T> {
  const tunnel = await openTarget(target);
  let session: InspectorSession | undefined;
  try {
    session = await connectInspector({ port: tunnel.port, host: tunnel.host });
    return await fn(session, tunnel.port);
  } finally {
    if (session) {
      await session.dispose();
    }
    await tunnel.dispose();
  }
}

export async function openTarget(target: Target): Promise<ResolvedTunnel> {
  if (target.kind === "port") {
    return {
      port: target.port,
      host: target.host,
      dispose: (): Promise<void> => Promise.resolve(),
    };
  }
  const tunnel = await openCfTunnel({
    region: target.region,
    org: target.org,
    space: target.space,
    app: target.app,
    tunnelReadyTimeoutMs: target.cfTimeoutMs,
  });
  return {
    port: tunnel.localPort,
    host: "127.0.0.1",
    dispose: async (): Promise<void> => {
      await tunnel.dispose();
    },
  };
}
