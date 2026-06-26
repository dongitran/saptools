import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { CfCliContext, CfSessionInput } from "./types.js";

const execFileAsync = promisify(execFile);

export interface CurrentCfTarget {
  readonly apiEndpoint: string;
  readonly orgName: string;
  readonly spaceName: string;
  readonly regionKey?: string;
}

const REGION_API_MAP: Record<string, string> = {
  ae01: "https://api.cf.ae01.hana.ondemand.com",
  ap01: "https://api.cf.ap01.hana.ondemand.com",
  ap10: "https://api.cf.ap10.hana.ondemand.com",
  ap11: "https://api.cf.ap11.hana.ondemand.com",
  ap12: "https://api.cf.ap12.hana.ondemand.com",
  ap20: "https://api.cf.ap20.hana.ondemand.com",
  ap21: "https://api.cf.ap21.hana.ondemand.com",
  ap30: "https://api.cf.ap30.hana.ondemand.com",
  br10: "https://api.cf.br10.hana.ondemand.com",
  br20: "https://api.cf.br20.hana.ondemand.com",
  br30: "https://api.cf.br30.hana.ondemand.com",
  ca10: "https://api.cf.ca10.hana.ondemand.com",
  ca20: "https://api.cf.ca20.hana.ondemand.com",
  ch20: "https://api.cf.ch20.hana.ondemand.com",
  cn20: "https://api.cf.cn20.platform.sapcloud.cn",
  cn40: "https://api.cf.cn40.platform.sapcloud.cn",
  eu01: "https://api.cf.eu01.hana.ondemand.com",
  eu02: "https://api.cf.eu02.hana.ondemand.com",
  eu10: "https://api.cf.eu10.hana.ondemand.com",
  "eu10-002": "https://api.cf.eu10-002.hana.ondemand.com",
  "eu10-003": "https://api.cf.eu10-003.hana.ondemand.com",
  "eu10-004": "https://api.cf.eu10-004.hana.ondemand.com",
  "eu10-005": "https://api.cf.eu10-005.hana.ondemand.com",
  "eu10-006": "https://api.cf.eu10-006.hana.ondemand.com",
  eu11: "https://api.cf.eu11.hana.ondemand.com",
  eu13: "https://api.cf.eu13.hana.ondemand.com",
  eu20: "https://api.cf.eu20.hana.ondemand.com",
  "eu20-001": "https://api.cf.eu20-001.hana.ondemand.com",
  eu30: "https://api.cf.eu30.hana.ondemand.com",
  in30: "https://api.cf.in30.hana.ondemand.com",
  jp10: "https://api.cf.jp10.hana.ondemand.com",
  jp20: "https://api.cf.jp20.hana.ondemand.com",
  jp30: "https://api.cf.jp30.hana.ondemand.com",
  jp31: "https://api.cf.jp31.hana.ondemand.com",
  sa30: "https://api.cf.sa30.hana.ondemand.com",
  us10: "https://api.cf.us10.hana.ondemand.com",
  "us10-001": "https://api.cf.us10-001.hana.ondemand.com",
  "us10-002": "https://api.cf.us10-002.hana.ondemand.com",
  us20: "https://api.cf.us20.hana.ondemand.com",
  us21: "https://api.cf.us21.hana.ondemand.com",
  us30: "https://api.cf.us30.hana.ondemand.com",
  // add more if needed, this covers common SAP BTP regions
};

export function getApiEndpointForRegion(regionKey: string): string | undefined {
  return REGION_API_MAP[regionKey];
}

export function getRegionKeyForApi(apiEndpoint: string): string | undefined {
  const normalized = apiEndpoint.trim().replace(/\/+$/, "").toLowerCase();
  for (const [key, api] of Object.entries(REGION_API_MAP)) {
    if (api.toLowerCase() === normalized) {
      return key;
    }
  }
  return undefined;
}

export async function readCurrentCfTarget(): Promise<CurrentCfTarget | undefined> {
  const cfBin = process.env["CF_EVENTS_CF_BIN"] ?? "cf";
  const isScript = cfBin.endsWith(".mjs") || cfBin.endsWith(".js");
  const file = isScript ? "node" : cfBin;
  const args = isScript ? [cfBin, "target"] : ["target"];
  try {
    const { stdout } = await execFileAsync(file, args, {
      maxBuffer: 1024 * 1024,
      timeout: 10000,
    });
    return parseCfTargetOutput(stdout);
  } catch {
    return undefined;
  }
}

export function parseCfTargetOutput(stdout: string): CurrentCfTarget | undefined {
  const fields = parseCfTargetFields(stdout);
  const apiEndpoint = fields.get("api endpoint");
  const orgName = fields.get("org");
  const spaceName = fields.get("space");
  if (!apiEndpoint || !orgName || !spaceName) {
    return undefined;
  }
  const regionKey = getRegionKeyForApi(apiEndpoint);
  return {
    apiEndpoint,
    orgName,
    spaceName,
    ...(regionKey ? { regionKey } : {}),
  };
}

function parseCfTargetFields(stdout: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const sep = line.indexOf(":");
    if (sep < 0) {
      continue;
    }
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (key && value) {
      fields.set(key, value);
    }
  }
  return fields;
}

const CF_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const CF_COMMAND_TIMEOUT_MS = 30_000;
const CF_RETRY_MAX_ATTEMPTS = 3;
const CF_RETRY_BASE_DELAY_MS = 120;
const GUID_PATTERN = /^[0-9a-f-]{16,}$/i;

interface ResolvedCommand {
  readonly bin: string;
  readonly argsPrefix: readonly string[];
}

/**
 * Runs `work` against an isolated, ephemeral `CF_HOME` so concurrent CF
 * sessions never share login state, and the directory is always cleaned up.
 */
export async function withCfSession<T>(work: (ctx: CfCliContext) => Promise<T>): Promise<T> {
  const cfHomeDir = await mkdtemp(join(tmpdir(), "saptools-cf-events-"));
  try {
    return await work({ cfHomeDir });
  } finally {
    await rm(cfHomeDir, { recursive: true, force: true });
  }
}

/** Authenticates the CF CLI and targets the requested org/space. */
export async function prepareCfCliSession(input: CfSessionInput, ctx: CfCliContext): Promise<void> {
  await runCfCommand(["api", input.apiEndpoint], ctx, "Failed to set the CF API endpoint.");
  await runCfCommand(["auth"], ctx, "Failed to authenticate the Cloud Foundry CLI.", {
    CF_USERNAME: input.credentials.email,
    CF_PASSWORD: input.credentials.password,
  });
  await runCfCommand(
    ["target", "-o", input.orgName, "-s", input.spaceName],
    ctx,
    "Failed to target the CF org and space.",
  );
}

/** Resolves the GUID of a targeted app via `cf app <name> --guid`. */
export async function cfAppGuid(appName: string, ctx: CfCliContext): Promise<string> {
  const stdout = await runCfCommand(
    ["app", appName, "--guid"],
    ctx,
    `Failed to resolve the GUID for app "${appName}".`,
  );
  const guid = stdout.trim();
  if (!GUID_PATTERN.test(guid)) {
    throw new Error(
      `Could not resolve the GUID for app "${appName}" - the CF CLI returned an unexpected value.`,
    );
  }
  return guid;
}

/** Calls a Cloud Foundry v3 API path via `cf curl` and returns the raw body. */
export async function cfCurl(path: string, ctx: CfCliContext): Promise<string> {
  return await runCfCommand(["curl", path], ctx, `Failed to call the CF API path "${path}".`);
}

export async function runCfCommand(
  args: readonly string[],
  ctx: CfCliContext,
  failureMessage: string,
  envOverrides: Readonly<Record<string, string>> = {},
): Promise<string> {
  const command = resolveCommand();
  const env = buildEnv(ctx.cfHomeDir, envOverrides);
  let lastError: unknown;

  for (let attempt = 1; attempt <= CF_RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await execFileWithResult(command.bin, [...command.argsPrefix, ...args], env);
    } catch (error) {
      lastError = error;
      if (attempt >= CF_RETRY_MAX_ATTEMPTS || !shouldRetryCfCliError(error)) {
        break;
      }
      await sleep(resolveRetryDelayMs(attempt));
    }
  }

  const detail = extractSafeCliDetail(lastError);
  throw new Error(detail.length > 0 ? `${failureMessage} ${detail}` : failureMessage, {
    cause: lastError,
  });
}

function resolveCommand(): ResolvedCommand {
  const bin = process.env["CF_EVENTS_CF_BIN"] ?? "cf";
  if (/\.(?:c|m)?js$/i.test(bin)) {
    return { bin: process.execPath, argsPrefix: [bin] };
  }
  return { bin, argsPrefix: [] };
}

function buildEnv(cfHomeDir: string, overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["SAP_EMAIL"];
  delete env["SAP_PASSWORD"];
  env["CF_HOME"] = cfHomeDir;
  Object.assign(env, overrides);
  return env;
}

async function execFileWithResult(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      command,
      [...args],
      { env, maxBuffer: CF_MAX_BUFFER_BYTES, timeout: CF_COMMAND_TIMEOUT_MS },
      (error: Error | null, stdout: string, stderr: string) => {
        if (error !== null) {
          rejectPromise(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

function shouldRetryCfCliError(error: unknown): boolean {
  const haystack = `${readErrorStderr(error)} ${readErrorMessage(error)}`.toLowerCase();
  if (
    haystack.includes("invalid") ||
    haystack.includes("credentials were rejected") ||
    haystack.includes("authentication failed") ||
    haystack.includes("not authorized") ||
    haystack.includes("forbidden")
  ) {
    return false;
  }
  return (
    haystack.includes("timeout") ||
    haystack.includes("timed out") ||
    haystack.includes("connection reset") ||
    haystack.includes("temporarily unavailable") ||
    haystack.includes("network") ||
    haystack.includes("econnreset") ||
    haystack.includes("econnrefused")
  );
}

function readErrorStderr(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }
  const stderr = (error as { readonly stderr?: unknown }).stderr;
  return typeof stderr === "string" ? stderr : "";
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function resolveRetryDelayMs(attempt: number): number {
  const jitter = Math.floor(Math.random() * CF_RETRY_BASE_DELAY_MS);
  return CF_RETRY_BASE_DELAY_MS * attempt + jitter;
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, delayMs);
  });
}

function extractSafeCliDetail(error: unknown): string {
  const stderr = readErrorStderr(error);
  if (stderr.length === 0) {
    return "";
  }
  const cleaned = stderr.replaceAll(/\s+/g, " ").trim();
  return cleaned.length > 0 ? `(cli: ${cleaned.slice(0, 180)})` : "";
}
