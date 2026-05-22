import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CfCliContext, CfSessionInput } from "./types.js";

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
