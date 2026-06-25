import type { CfLiveTraceTarget, LiveTraceStartOptions } from "../types.js";

export type OutputFormat = "ndjson" | "summary" | "json";

export interface CliFlags {
  readonly region?: string;
  readonly apiEndpoint?: string;
  readonly org?: string;
  readonly space?: string;
  readonly app?: string;
  readonly email?: string;
  readonly password?: string;
  readonly instance?: string;
  readonly cfHome?: string;
  readonly cfCommand?: string;
  readonly duration?: string;
  readonly maxEvents?: string;
  readonly maxBodyBytes?: string;
  readonly captureHeaders?: boolean;
  readonly captureRequestBody?: boolean;
  readonly captureResponseBody?: boolean;
  readonly uninstallOnExit?: boolean;
  readonly format?: string;
  readonly quiet?: boolean;
}

export interface RunOptions {
  readonly target: CfLiveTraceTarget;
  readonly trace: Required<LiveTraceStartOptions>;
  readonly limits: {
    readonly durationMs?: number;
    readonly maxEvents?: number;
  };
  readonly format: OutputFormat;
  readonly uninstallOnExit: boolean;
  readonly quiet: boolean;
}

export function buildRunOptions(flags: CliFlags, env: Record<string, string | undefined>): RunOptions {
  requireRegionOrApi(flags);
  const target = buildTarget(flags, env);
  return {
    target,
    trace: {
      captureHeaders: flags.captureHeaders !== false,
      captureRequestBody: flags.captureRequestBody !== false,
      captureResponseBody: flags.captureResponseBody !== false,
      maxBodyBytes: parseBodyLimit(flags.maxBodyBytes),
      runtimeQueueSize: 1000,
    },
    limits: buildLimits(flags),
    format: parseFormat(flags.format),
    uninstallOnExit: flags.uninstallOnExit !== false,
    quiet: flags.quiet === true,
  };
}

export function parsePositiveInteger(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || String(value) !== raw.trim()) {
    throw new Error(`Invalid ${label}: "${raw}" — expected a positive integer.`);
  }
  return value;
}

function buildTarget(flags: CliFlags, env: Record<string, string | undefined>): CfLiveTraceTarget {
  const apiPart = flags.apiEndpoint === undefined ? { region: requireText(flags.region, "--region") } : { apiEndpoint: requireText(flags.apiEndpoint, "--api-endpoint") };
  return {
    ...apiPart,
    org: requireText(flags.org, "--org"),
    space: requireText(flags.space, "--space"),
    app: requireText(flags.app, "--app"),
    email: resolveCredential(flags.email, env, "SAP_EMAIL"),
    password: resolveCredential(flags.password, env, "SAP_PASSWORD"),
    instanceIndex: parseInstanceIndex(flags.instance),
    ...(flags.cfHome === undefined ? {} : { cfHomeDir: requireText(flags.cfHome, "--cf-home") }),
    ...(flags.cfCommand === undefined ? {} : { command: requireText(flags.cfCommand, "--cf-command") }),
  };
}

function buildLimits(flags: CliFlags): RunOptions["limits"] {
  const duration = parsePositiveInteger(flags.duration, "--duration");
  const maxEvents = parsePositiveInteger(flags.maxEvents, "--max-events");
  return {
    ...(duration === undefined ? {} : { durationMs: duration * 1000 }),
    ...(maxEvents === undefined ? {} : { maxEvents }),
  };
}

function requireRegionOrApi(flags: CliFlags): void {
  const hasRegion = flags.region !== undefined && flags.region.trim().length > 0;
  const hasApi = flags.apiEndpoint !== undefined && flags.apiEndpoint.trim().length > 0;
  if (!hasRegion && !hasApi) {
    throw new Error("Either --region or --api-endpoint is required.");
  }
}

function requireText(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function resolveCredential(value: string | undefined, env: Record<string, string | undefined>, envName: string): string {
  const directValue = value?.trim();
  if (directValue !== undefined && directValue.length > 0) {
    return directValue;
  }
  const envValue = env[envName]?.trim();
  if (envValue !== undefined && envValue.length > 0) {
    return envValue;
  }
  throw new Error(`Missing required environment variable: ${envName}`);
}

function parseInstanceIndex(value: string | undefined): number {
  const parsed = value === undefined ? undefined : parseNonNegativeInteger(value, "--instance");
  return parsed ?? 0;
}

function parseBodyLimit(value: string | undefined): number {
  if (value === undefined) {
    return 4096;
  }
  return parseNonNegativeInteger(value, "--max-body-bytes");
}

function parseNonNegativeInteger(raw: string, label: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0 || String(value) !== raw.trim()) {
    throw new Error(`Invalid ${label}: "${raw}" — expected a non-negative integer.`);
  }
  return value;
}

function parseFormat(value: string | undefined): OutputFormat {
  if (value === undefined || value === "ndjson") {
    return "ndjson";
  }
  if (value === "summary" || value === "json") {
    return value;
  }
  throw new Error(`Invalid --format: "${value}" — expected ndjson, summary, or json.`);
}
