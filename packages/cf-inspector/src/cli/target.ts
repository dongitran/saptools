import {
  type SessionStatus,
} from "@saptools/cf-debugger";

import { openCfTunnel } from "../cf/tunnel.js";
import { connectInspector } from "../inspector/session.js";
import type { InspectorSession } from "../inspector/types.js";
import { CfInspectorError } from "../types.js";

import { DEFAULT_CF_TIMEOUT_SEC } from "./commandTypes.js";
import type { SharedTargetOptions, Target } from "./commandTypes.js";
import { warnOnImplicitInspectorSelection } from "./warnings.js";

export type ProgressReporter = (message: string) => void;

const CF_TUNNEL_STATUS_MESSAGES = {
  starting: "Preparing the Cloud Foundry debugger...",
  "logging-in": "Logging in to Cloud Foundry...",
  targeting: "Targeting the Cloud Foundry org and space...",
  "ssh-enabling": "Enabling SSH for the Cloud Foundry app...",
  "ssh-restarting": "Restarting the Cloud Foundry app to activate SSH...",
  signaling: "Starting the remote Node.js inspector...",
  tunneling: "Opening the SSH inspector tunnel...",
  ready: "Cloud Foundry inspector tunnel is ready.",
  stopping: "Closing the Cloud Foundry inspector tunnel...",
  stopped: "Cloud Foundry inspector tunnel closed.",
  error: "Cloud Foundry inspector tunnel failed.",
} as const satisfies Readonly<Record<SessionStatus, string>>;

export function formatCfTunnelStatus(status: SessionStatus): string {
  return CF_TUNNEL_STATUS_MESSAGES[status];
}

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

export interface TargetResolveOptions {
  readonly useTimeoutForTunnel?: boolean;
}

export function resolveTarget(opts: SharedTargetOptions, options: TargetResolveOptions = {}): Target {
  const port = parsePositiveInt(opts.port, "--port");
  const targetIndex = parseTargetIndex(opts.target);
  const workerIndex = parseSelectionIndex(opts.worker, "--worker");
  if (port !== undefined) {
    return {
      kind: "port",
      port,
      host: opts.host ?? "127.0.0.1",
      ...selectionOptions(targetIndex, workerIndex),
    };
  }

  const region = optionalText(opts.region);
  const org = optionalText(opts.org);
  const space = optionalText(opts.space);
  const app = optionalText(opts.app);
  const missingFlags = [
    ...(region === undefined ? ["--region"] : []),
    ...(org === undefined ? ["--org"] : []),
    ...(space === undefined ? ["--space"] : []),
    ...(app === undefined ? ["--app"] : []),
  ];
  if (region === undefined || org === undefined || space === undefined || app === undefined) {
    throw new CfInspectorError(
      "MISSING_TARGET",
      `Cloud Foundry targeting requires explicit selectors. Missing: ${missingFlags.join(", ")}. ` +
        "cf-inspector does not consult ambient `cf target` because it can silently change between runs.",
    );
  }

  return buildCfTarget(
    region,
    optionalText(opts.apiEndpoint),
    org,
    space,
    app,
    parseTunnelTimeout(opts, options),
    targetIndex,
    workerIndex,
  );
}

export async function resolveTargetWithCurrentCfTarget(
  opts: SharedTargetOptions,
  options: TargetResolveOptions = {},
): Promise<Target> {
  return await Promise.resolve(resolveTarget(opts, options));
}

function parseTunnelTimeout(opts: SharedTargetOptions, options: TargetResolveOptions): number {
  if (options.useTimeoutForTunnel === false) {
    return DEFAULT_CF_TIMEOUT_SEC;
  }
  return parsePositiveInt(opts.timeout, "--timeout") ?? DEFAULT_CF_TIMEOUT_SEC;
}

function parseTargetIndex(raw: string | undefined): number | undefined {
  return parseSelectionIndex(raw, "--target");
}

function parseSelectionIndex(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 0 || value.toString() !== raw.trim()) {
    throw new CfInspectorError(
      "INVALID_ARGUMENT",
      `Invalid ${label}: "${raw}" — expected a non-negative integer`,
    );
  }
  return value;
}

function targetIndexOption(targetIndex: number | undefined): { readonly targetIndex?: number } {
  return targetIndex === undefined ? {} : { targetIndex };
}

function selectionOptions(
  targetIndex: number | undefined,
  workerIndex: number | undefined,
): { readonly targetIndex?: number; readonly workerIndex?: number } {
  return {
    ...targetIndexOption(targetIndex),
    ...(workerIndex === undefined ? {} : { workerIndex }),
  };
}

function buildCfTarget(
  region: string,
  apiEndpoint: string | undefined,
  org: string,
  space: string,
  app: string,
  tunnelTimeoutSec: number,
  targetIndex: number | undefined,
  workerIndex: number | undefined,
): Target {
  return {
    kind: "cf",
    region,
    ...(apiEndpoint === undefined ? {} : { apiEndpoint }),
    org,
    space,
    app,
    tunnelTimeoutMs: tunnelTimeoutSec * 1000,
    ...selectionOptions(targetIndex, workerIndex),
  };
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

interface ResolvedTunnel {
  readonly port: number;
  readonly host: string;
  readonly dispose: () => Promise<void>;
}

export async function withSession<T>(
  target: Target,
  fn: (session: InspectorSession, port: number) => Promise<T>,
  reportProgress?: ProgressReporter,
  signal?: AbortSignal,
): Promise<T> {
  const tunnel = await openTarget(target, reportProgress, signal);
  let session: InspectorSession | undefined;
  try {
    reportProgress?.(
      `Connecting to the Node.js inspector at ${tunnel.host}:${tunnel.port.toString()}...`,
    );
    session = await connectInspector({
      port: tunnel.port,
      host: tunnel.host,
      ...selectionOptions(target.targetIndex, target.workerIndex),
    });
    warnOnImplicitInspectorSelection(
      session,
      target.targetIndex !== undefined,
      target.workerIndex !== undefined,
    );
    reportProgress?.("Inspector session is ready.");
    return await fn(session, tunnel.port);
  } finally {
    if (session) {
      reportProgress?.("Closing the inspector session...");
      await session.dispose();
      reportProgress?.("Inspector session closed.");
    }
    await tunnel.dispose();
  }
}

export async function openTarget(
  target: Target,
  reportProgress?: ProgressReporter,
  signal?: AbortSignal,
): Promise<ResolvedTunnel> {
  if (target.kind === "port") {
    return {
      port: target.port,
      host: target.host,
      dispose: (): Promise<void> => Promise.resolve(),
    };
  }
  reportProgress?.(formatCfTunnelStatus("starting"));
  const tunnel = await openCfTunnel({
    region: target.region,
    ...(target.apiEndpoint === undefined ? {} : { apiEndpoint: target.apiEndpoint }),
    org: target.org,
    space: target.space,
    app: target.app,
    tunnelReadyTimeoutMs: target.tunnelTimeoutMs,
    ...(signal === undefined ? {} : { signal }),
    ...(reportProgress === undefined
      ? {}
      : {
          onStatus: (status: SessionStatus, message?: string): void => {
            reportProgress(message ?? formatCfTunnelStatus(status));
          },
        }),
  });
  return {
    port: tunnel.localPort,
    host: "127.0.0.1",
    dispose: async (): Promise<void> => {
      await tunnel.dispose();
    },
  };
}
