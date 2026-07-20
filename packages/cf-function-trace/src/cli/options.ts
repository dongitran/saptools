import { isAbsolute, normalize } from "node:path";

import { TraceDataError } from "../errors.js";
import type { TraceTarget } from "../session.js";

export interface RecordCliFlags {
  readonly port?: string;
  readonly host?: string;
  readonly target?: string;
  readonly worker?: string;
  readonly region?: string;
  readonly apiEndpoint?: string;
  readonly org?: string;
  readonly space?: string;
  readonly app?: string;
  readonly process?: string;
  readonly instance?: string;
  readonly nodePid?: string;
  readonly tunnelPort?: string;
  readonly callDepth?: string;
  readonly timeout?: string;
  readonly maxSteps?: string;
  readonly maxPausedMs?: string;
  readonly checkpointEvery?: string;
  readonly maxObjectDepth?: string;
  readonly maxRootVars?: string;
  readonly maxProperties?: string;
  readonly maxNodes?: string;
  readonly maxStateBytes?: string;
  readonly appRoot?: string;
  readonly match?: string;
  readonly asyncStackDepth?: string;
  readonly confirmImpact: boolean;
}

export interface ResolvedTraceLimits {
  readonly callDepth: number;
  readonly timeoutMs: number;
  readonly maxSteps: number;
  readonly maxPausedMs: number;
  readonly checkpointEvery: number;
  readonly maxObjectDepth: number;
  readonly maxRootVars: number;
  readonly maxProperties: number;
  readonly maxNodes: number;
  readonly maxStateBytes: number;
  readonly asyncStackDepth: number;
}

export interface ResolvedRecordOptions {
  readonly target: TraceTarget;
  readonly limits: ResolvedTraceLimits;
  readonly appRoot?: string;
  readonly matchCondition?: string;
}

function parseInteger(raw: string, label: string, minimum: number, maximum: number): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum || value.toString() !== raw.trim()) {
    throw new TraceDataError("INVALID_ARGUMENT", `${label} must be an integer from ${minimum.toString()} to ${maximum.toString()}.`);
  }
  return value;
}

function optionalInteger(
  raw: string | undefined,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  return raw === undefined ? undefined : parseInteger(raw, label, minimum, maximum);
}

function optionalIndex(raw: string | undefined, label: string): number | undefined {
  return optionalInteger(raw, label, 0, 100_000);
}

function requiredText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (text === undefined || text.length === 0) {
    throw new TraceDataError("INVALID_ARGUMENT", `${label} is required for a Cloud Foundry target.`);
  }
  return text;
}

function hasCfSelector(flags: RecordCliFlags): boolean {
  return [
    flags.region,
    flags.apiEndpoint,
    flags.org,
    flags.space,
    flags.app,
    flags.process,
    flags.instance,
    flags.nodePid,
    flags.tunnelPort,
  ]
    .some((value) => value !== undefined);
}

function selectionFields(flags: RecordCliFlags): {
  readonly targetIndex?: number;
  readonly workerIndex?: number;
} {
  const targetIndex = optionalIndex(flags.target, "--target");
  const workerIndex = optionalIndex(flags.worker, "--worker");
  return {
    ...(targetIndex === undefined ? {} : { targetIndex }),
    ...(workerIndex === undefined ? {} : { workerIndex }),
  };
}

function localTarget(flags: RecordCliFlags): TraceTarget {
  if (hasCfSelector(flags)) {
    throw new TraceDataError("INVALID_ARGUMENT", "Local --port and Cloud Foundry selectors cannot be mixed.");
  }
  const host = flags.host?.trim() ?? "127.0.0.1";
  if (host.length === 0) {
    throw new TraceDataError("INVALID_ARGUMENT", "--host cannot be empty.");
  }
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new TraceDataError(
      "INVALID_ARGUMENT",
      "--host must be a loopback address; use explicit Cloud Foundry selectors for remote tracing.",
    );
  }
  return {
    kind: "local",
    host,
    port: parseInteger(requiredText(flags.port, "--port"), "--port", 1, 65_535),
    ...selectionFields(flags),
  };
}

function cfTarget(flags: RecordCliFlags): TraceTarget {
  const process = flags.process?.trim() ?? "web";
  const hasControlCharacter = Array.from(process).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (process.length === 0 || hasControlCharacter) {
    throw new TraceDataError("INVALID_ARGUMENT", "--process must be a non-empty process name.");
  }
  const instance = optionalIndex(flags.instance, "--instance") ?? 0;
  const nodePid = optionalInteger(flags.nodePid, "--node-pid", 1, 2_147_483_647);
  const preferredPort = optionalInteger(flags.tunnelPort, "--tunnel-port", 1, 65_535);
  return {
    kind: "cf",
    region: requiredText(flags.region, "--region"),
    ...(flags.apiEndpoint === undefined ? {} : { apiEndpoint: requiredText(flags.apiEndpoint, "--api-endpoint") }),
    org: requiredText(flags.org, "--org"),
    space: requiredText(flags.space, "--space"),
    app: requiredText(flags.app, "--app"),
    process,
    instance,
    ...(nodePid === undefined ? {} : { nodePid }),
    ...(preferredPort === undefined ? {} : { preferredPort }),
    ...selectionFields(flags),
    confirmImpact: flags.confirmImpact,
  };
}

function boundedLimit(
  raw: string | undefined,
  fallback: string,
  label: string,
  minimum: number,
  maximum: number,
): number {
  return parseInteger(raw ?? fallback, label, minimum, maximum);
}

function resolveLimits(flags: RecordCliFlags): ResolvedTraceLimits {
  return {
    callDepth: boundedLimit(flags.callDepth, "0", "--call-depth", 0, 2),
    timeoutMs: boundedLimit(flags.timeout, "60", "--timeout", 1, 3600) * 1000,
    maxSteps: boundedLimit(flags.maxSteps, "200", "--max-steps", 1, 10_000),
    maxPausedMs: boundedLimit(flags.maxPausedMs, "5000", "--max-paused-ms", 1, 600_000),
    checkpointEvery: boundedLimit(flags.checkpointEvery, "25", "--checkpoint-every", 1, 1000),
    maxObjectDepth: boundedLimit(flags.maxObjectDepth, "4", "--max-object-depth", 0, 20),
    maxRootVars: boundedLimit(flags.maxRootVars, "100", "--max-root-vars", 1, 10_000),
    maxProperties: boundedLimit(flags.maxProperties, "100", "--max-properties", 1, 10_000),
    maxNodes: boundedLimit(flags.maxNodes, "1000", "--max-nodes", 1, 100_000),
    maxStateBytes: boundedLimit(flags.maxStateBytes, "2000000", "--max-state-bytes", 1024, 100_000_000),
    asyncStackDepth: boundedLimit(flags.asyncStackDepth, "4", "--async-stack-depth", 0, 100),
  };
}

function resolveMatchCondition(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  const hasControlCharacter = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (value.length > 1024 || hasControlCharacter) {
    throw new TraceDataError("INVALID_ARGUMENT", "--match must be a single-line JavaScript expression under 1024 characters.");
  }
  return value;
}

function resolveAppRoot(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (value === undefined) {
    return undefined;
  }
  const hasControlCharacter = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (value.length === 0 || !isAbsolute(value) || hasControlCharacter) {
    throw new TraceDataError("INVALID_ARGUMENT", "--app-root must be an absolute runtime path.");
  }
  return normalize(value);
}

export function resolveRecordOptions(flags: RecordCliFlags): ResolvedRecordOptions {
  const target = flags.port === undefined ? cfTarget(flags) : localTarget(flags);
  const appRoot = resolveAppRoot(flags.appRoot);
  const matchCondition = resolveMatchCondition(flags.match);
  return {
    target,
    limits: resolveLimits(flags),
    ...(appRoot === undefined ? {} : { appRoot }),
    ...(matchCondition === undefined ? {} : { matchCondition }),
  };
}
