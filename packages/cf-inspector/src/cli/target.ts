import {
  type SessionStatus,
} from "@saptools/cf-debugger";

import { openCfTunnel } from "../cf/tunnel.js";
import { connectInspector, connectInspectorGroup } from "../inspector/session.js";
import type { InspectorSession, InspectorSessionGroup } from "../inspector/types.js";
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
  const workerId = parseWorkerId(opts.workerId);
  const mainOnly = opts.mainOnly === true;
  validateIsolateSelectors(targetIndex, workerIndex, workerId, mainOnly);
  if (port !== undefined) {
    return {
      kind: "port",
      port,
      host: opts.host ?? "127.0.0.1",
      ...selectionOptions(targetIndex, workerIndex, workerId, mainOnly),
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
    workerId,
    mainOnly,
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
  workerId?: string,
  mainOnly?: boolean,
): { readonly targetIndex?: number; readonly workerIndex?: number; readonly workerId?: string; readonly mainOnly?: boolean } {
  return {
    ...targetIndexOption(targetIndex),
    ...(workerIndex === undefined ? {} : { workerIndex }),
    ...(workerId === undefined ? {} : { workerId }),
    ...(mainOnly === true ? { mainOnly: true } : {}),
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
  workerId: string | undefined,
  mainOnly: boolean,
): Target {
  return {
    kind: "cf",
    region,
    ...(apiEndpoint === undefined ? {} : { apiEndpoint }),
    org,
    space,
    app,
    tunnelTimeoutMs: tunnelTimeoutSec * 1000,
    ...selectionOptions(targetIndex, workerIndex, workerId, mainOnly),
  };
}

function validateIsolateSelectors(
  targetIndex: number | undefined,
  workerIndex: number | undefined,
  workerId: string | undefined,
  mainOnly: boolean,
): void {
  const workerSelectors = Number(workerIndex !== undefined) + Number(workerId !== undefined);
  if (workerSelectors > 1 || (mainOnly && workerSelectors > 0)) {
    throw new CfInspectorError(
      "INVALID_ARGUMENT",
      "Use only one of --worker, --worker-id, or --main-only.",
    );
  }
  if (targetIndex !== undefined && workerSelectors === 0 && !mainOnly) {
    return;
  }
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function parseWorkerId(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CfInspectorError(
      "INVALID_ARGUMENT",
      "Invalid --worker-id: expected a non-empty workerId from list-targets",
    );
  }
  return trimmed;
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
      ...(target.workerId === undefined ? {} : { workerId: target.workerId }),
    });
    warnOnImplicitInspectorSelection(
      session,
      target.targetIndex !== undefined,
      target.workerIndex !== undefined || target.workerId !== undefined,
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

export async function withSessions<T>(
  target: Target,
  fn: (group: InspectorSessionGroup, port: number) => Promise<T>,
  reportProgress?: ProgressReporter,
  signal?: AbortSignal,
): Promise<T> {
  const tunnel = await openTarget(target, reportProgress, signal);
  let group: InspectorSessionGroup | undefined;
  try {
    reportProgress?.(
      `Connecting to the Node.js inspector at ${tunnel.host}:${tunnel.port.toString()}...`,
    );
    const autoAttach = target.targetIndex === undefined && target.workerIndex === undefined &&
      target.workerId === undefined && target.mainOnly !== true;
    if (autoAttach) {
      group = await connectInspectorGroup({ port: tunnel.port, host: tunnel.host });
    } else {
      const session = await connectInspector({
        port: tunnel.port,
        host: tunnel.host,
        ...selectionOptions(target.targetIndex, target.workerIndex, target.workerId),
      });
      group = singleSessionGroup(session);
    }
    reportProgress?.("Inspector session is ready.");
    return await fn(group, tunnel.port);
  } finally {
    try {
      if (group !== undefined) {
        const sessionCount = group.list().length;
        reportProgress?.(sessionCount === 1
          ? "Closing the inspector session..."
          : `Closing ${sessionCount.toString()} inspector sessions...`);
        await group.dispose();
        reportProgress?.(sessionCount === 1
          ? "Inspector session closed."
          : "Inspector sessions closed.");
      }
    } finally {
      await tunnel.dispose();
    }
  }
}

function singleSessionGroup(session: InspectorSession): InspectorSessionGroup {
  return {
    targetIndex: session.targetIndex ?? 0,
    targetCount: session.targetCount ?? 1,
    workerDiscoverySupported: session.workerDiscoverySupported ?? false,
    list: (): readonly InspectorSession[] => [session],
    onSession: (listener): (() => void) => {
      listener(session);
      return (): void => undefined;
    },
    onSessionRemoved: (): (() => void) => (): void => undefined,
    onError: (): (() => void) => (): void => undefined,
    dispose: async (): Promise<void> => {
      await session.dispose();
    },
  };
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
