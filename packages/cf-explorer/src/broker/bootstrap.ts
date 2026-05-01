import { normalizeTarget, resolveInstance, resolveProcessName } from "../cf/target.js";
import { CfExplorerError } from "../core/errors.js";
import type { ExplorerTarget } from "../core/types.js";

export interface BrokerBootstrap {
  readonly sessionId: string;
  readonly homeDir: string;
  readonly target: ExplorerTarget;
  readonly process: string;
  readonly instance: number;
  readonly cfBin?: string;
  readonly idleTimeoutMs?: number;
  readonly maxLifetimeMs?: number;
}

export function parseBrokerBootstrap(raw: string | undefined): BrokerBootstrap {
  if (raw === undefined || raw.length === 0) {
    throw new CfExplorerError("BROKER_UNAVAILABLE", "Missing broker bootstrap payload.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new CfExplorerError("BROKER_UNAVAILABLE", "Invalid broker bootstrap payload.");
  }
  try {
    return normalizeBootstrap(parsed);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CfExplorerError("BROKER_UNAVAILABLE", `Invalid broker bootstrap payload: ${message}`);
  }
}

function normalizeBootstrap(value: unknown): BrokerBootstrap {
  if (typeof value !== "object" || value === null) {
    throw new CfExplorerError("UNSAFE_INPUT", "Bootstrap payload must be an object.");
  }
  const candidate = value as Partial<BrokerBootstrap>;
  const target = normalizeBootstrapTarget((value as { readonly target?: unknown }).target);
  if (typeof candidate.instance !== "number") {
    throw new CfExplorerError("UNSAFE_INPUT", "Bootstrap instance is required.");
  }
  const idleTimeoutMs = readOptionalPositiveInteger(candidate.idleTimeoutMs, "idleTimeoutMs");
  const maxLifetimeMs = readOptionalPositiveInteger(candidate.maxLifetimeMs, "maxLifetimeMs");
  return {
    sessionId: readBootstrapText(candidate.sessionId, "sessionId"),
    homeDir: readBootstrapText(candidate.homeDir, "homeDir"),
    target,
    process: resolveProcessName(readBootstrapText(candidate.process, "process")),
    instance: resolveInstance(candidate.instance),
    ...(candidate.cfBin === undefined ? {} : { cfBin: readBootstrapText(candidate.cfBin, "cfBin") }),
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    ...(maxLifetimeMs === undefined ? {} : { maxLifetimeMs }),
  };
}

function normalizeBootstrapTarget(value: unknown): ExplorerTarget {
  if (typeof value !== "object" || value === null) {
    throw new CfExplorerError("UNSAFE_INPUT", "Bootstrap target is required.");
  }
  const candidate = value as {
    readonly region?: unknown;
    readonly org?: unknown;
    readonly space?: unknown;
    readonly app?: unknown;
    readonly apiEndpoint?: unknown;
  };
  if (
    typeof candidate.region !== "string" ||
    typeof candidate.org !== "string" ||
    typeof candidate.space !== "string" ||
    typeof candidate.app !== "string"
  ) {
    throw new CfExplorerError("UNSAFE_INPUT", "Bootstrap target fields are required.");
  }
  if (candidate.apiEndpoint !== undefined && typeof candidate.apiEndpoint !== "string") {
    throw new CfExplorerError("UNSAFE_INPUT", "Bootstrap apiEndpoint must be a string.");
  }
  return normalizeTarget({
    region: candidate.region,
    org: candidate.org,
    space: candidate.space,
    app: candidate.app,
    ...(candidate.apiEndpoint === undefined ? {} : { apiEndpoint: candidate.apiEndpoint }),
  });
}

function readBootstrapText(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CfExplorerError("UNSAFE_INPUT", `${key} is required.`);
  }
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new CfExplorerError("UNSAFE_INPUT", `${key} must not contain control line breaks.`);
  }
  return value;
}

function readOptionalPositiveInteger(value: unknown, key: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    throw new CfExplorerError("UNSAFE_INPUT", `${key} must be a positive integer.`);
  }
  return value;
}
