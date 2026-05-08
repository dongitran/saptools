import { execFile, spawn } from "node:child_process";

import { getAllRegions } from "@saptools/cf-sync";

import type {
  FetchRecentLogsFromTargetInput,
  FetchRecentLogsInput,
  LogStreamHandle,
  LogStreamProcess,
  LogStreamStartInput,
  PrepareCfCliSessionInput,
  StartedAppRow,
} from "./types.js";

const CF_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const CF_COMMAND_TIMEOUT_MS = 30_000;
const CF_RETRY_MAX_ATTEMPTS = 3;
const CF_RETRY_BASE_DELAY_MS = 120;

export function resolveApiEndpoint(
  input: Pick<PrepareCfCliSessionInput, "apiEndpoint" | "region">,
): string {
  if (typeof input.apiEndpoint === "string" && input.apiEndpoint.length > 0) {
    return input.apiEndpoint;
  }
  const region = getAllRegions().find((item) => item.key === input.region);
  if (region === undefined) {
    throw new Error(`Unknown CF region: ${input.region ?? "<missing>"}`);
  }
  return region.apiEndpoint;
}

export function parseCfAppsOutput(stdout: string): readonly StartedAppRow[] {
  const headerIndex = stdout.split(/\r?\n/).findIndex((line) => line.includes("requested state"));
  if (headerIndex < 0) {
    return [];
  }
  return stdout
    .split(/\r?\n/)
    .slice(headerIndex + 1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseCfAppRow)
    .filter((row): row is StartedAppRow => row !== undefined);
}

export async function prepareCfCliSession(
  input: PrepareCfCliSessionInput,
): Promise<void> {
  const apiEndpoint = resolveApiEndpoint(input);
  const options = buildCommandOptions(input.cfHomeDir, input.command, {
    CF_USERNAME: input.email,
    CF_PASSWORD: input.password,
  });

  await runCfCommand(["api", apiEndpoint], options, "Failed to set CF API endpoint.");
  await runCfCommand(["auth"], options, "Failed to authenticate Cloud Foundry CLI.");
  await runCfCommand(
    ["target", "-o", input.org, "-s", input.space],
    buildCommandOptions(input.cfHomeDir, input.command),
    "Failed to target CF org/space.",
  );
}

export async function fetchStartedAppsViaCfCli(
  input: PrepareCfCliSessionInput,
): Promise<readonly { readonly name: string; readonly runningInstances: number }[]> {
  await prepareCfCliSession(input);
  const stdout = await runCfCommand(
    ["apps"],
    buildCommandOptions(input.cfHomeDir, input.command),
    "Failed to fetch apps from CF CLI.",
  );
  return parseCfAppsOutput(stdout)
    .filter((row) => row.requestedState === "started" && row.runningInstances > 0)
    .map((row) => ({ name: row.name, runningInstances: row.runningInstances }));
}

export async function fetchRecentLogs(
  input: FetchRecentLogsInput,
): Promise<string> {
  await prepareCfCliSession(input);
  return await fetchRecentLogsFromTarget({
    appName: input.app,
    ...(input.cfHomeDir === undefined ? {} : { cfHomeDir: input.cfHomeDir }),
    ...(input.command === undefined ? {} : { command: input.command }),
  });
}

export async function fetchRecentLogsFromTarget(
  input: FetchRecentLogsFromTargetInput,
): Promise<string> {
  return await runCfCommand(
    ["logs", input.appName, "--recent"],
    buildCommandOptions(input.cfHomeDir, input.command),
    `Failed to fetch recent logs for app "${input.appName}".`,
  );
}

export function spawnLogStreamFromTarget(
  input: LogStreamStartInput,
): LogStreamHandle {
  const command = resolveCommand(input.command);
  const child = spawn(command.bin, [...command.argsPrefix, "logs", input.appName], {
    env: buildCfCliEnv(input.cfHomeDir),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    process: child as unknown as LogStreamProcess,
    stop(): void {
      if (!child.killed) {
        child.kill();
      }
    },
  };
}

function parseCfAppRow(line: string): StartedAppRow | undefined {
  const parts = line.split(/\s{2,}/);
  const name = parts[0]?.trim() ?? "";
  const requestedState = (parts[1]?.trim() ?? "").toLowerCase();
  const instancesToken = parts[2]?.trim() ?? "";
  if (name.length === 0 || requestedState.length === 0) {
    return undefined;
  }
  return { name, requestedState, runningInstances: parseRunningInstances(instancesToken) };
}

function parseRunningInstances(instancesToken: string): number {
  const regex = /(?:^|[, ])(?:[a-zA-Z0-9_-]+:)?(\d+)\/\d+/g;
  let total = 0;
  let match = regex.exec(instancesToken);
  while (match !== null) {
    total += Number.parseInt(match[1] ?? "0", 10);
    match = regex.exec(instancesToken);
  }
  return total;
}

function resolveBin(command?: string): string {
  return command ?? process.env["CF_LOGS_CF_BIN"] ?? "cf";
}

function resolveCommand(command?: string): {
  readonly bin: string;
  readonly argsPrefix: readonly string[];
} {
  const resolvedBin = resolveBin(command);
  return isNodeScriptCommand(resolvedBin)
    ? { bin: process.execPath, argsPrefix: [resolvedBin] }
    : { bin: resolvedBin, argsPrefix: [] };
}

function isNodeScriptCommand(command: string): boolean {
  return /\.(?:c|m)?js$/i.test(command);
}

function buildCfCliEnv(cfHomeDir?: string, envOverrides?: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["SAP_EMAIL"];
  delete env["SAP_PASSWORD"];
  if (typeof cfHomeDir === "string" && cfHomeDir.length > 0) {
    env["CF_HOME"] = cfHomeDir;
  }
  if (envOverrides !== undefined) {
    Object.assign(env, envOverrides);
  }
  return env;
}

function buildCommandOptions(
  cfHomeDir?: string,
  command?: string,
  envOverrides?: Record<string, string>,
): {
  readonly command: string;
  readonly argsPrefix: readonly string[];
  readonly env: NodeJS.ProcessEnv;
} {
  const resolvedCommand = resolveCommand(command);
  return {
    command: resolvedCommand.bin,
    argsPrefix: resolvedCommand.argsPrefix,
    env: buildCfCliEnv(cfHomeDir, envOverrides),
  };
}

async function runCfCommand(
  args: readonly string[],
  options: {
    readonly command: string;
    readonly argsPrefix: readonly string[];
    readonly env: NodeJS.ProcessEnv;
  },
  failureMessage: string,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CF_RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      const { stdout } = await execFileWithResult(
        options.command,
        [...options.argsPrefix, ...args],
        options.env,
      );
      return stdout;
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
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function execFileWithResult(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      [...args],
      { env, maxBuffer: CF_MAX_BUFFER_BYTES, timeout: CF_COMMAND_TIMEOUT_MS },
      (error: Error | null, stdout: string, stderr: string) => {
        if (error !== null) {
          const enriched = Object.assign(error, { stdout, stderr });
          rejectPromise(enriched);
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}

function extractSafeCliDetail(error: unknown): string {
  const stderr = typeof (error as { readonly stderr?: unknown }).stderr === "string"
    ? String((error as { readonly stderr?: unknown }).stderr).replaceAll(/\s+/g, " ").trim()
    : "";
  return stderr.length > 0 ? `(cli: ${stderr.slice(0, 180)})` : "";
}
