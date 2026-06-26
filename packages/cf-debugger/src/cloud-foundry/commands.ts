import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { listKnownRegionKeys, resolveApiEndpoint } from "../regions.js";
import { CfDebuggerError } from "../types.js";

import { type CfExecContext, runCf } from "./execute.js";
import { parseAppNames, parseNameTable } from "./parsers.js";

const execFileAsync = promisify(execFile);

const CF_AUTH_MAX_ATTEMPTS = 3;
const CURRENT_TARGET_TIMEOUT_MS = 30_000;

export interface CurrentCfTargetReadOptions {
  readonly command?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

export interface CurrentCfTarget {
  readonly apiEndpoint: string;
  readonly region?: string;
  readonly org: string;
  readonly space: string;
}

export async function cfApi(apiEndpoint: string, context: CfExecContext): Promise<void> {
  await runCf(["api", apiEndpoint], context);
}

export async function cfAuth(
  email: string,
  password: string,
  context: CfExecContext,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CF_AUTH_MAX_ATTEMPTS; attempt++) {
    try {
      await runCf(["auth", email, password], context);
      return;
    } catch (err: unknown) {
      lastError = err;
      if (attempt < CF_AUTH_MAX_ATTEMPTS - 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1000 * (attempt + 1));
        });
      }
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new CfDebuggerError("CF_AUTH_FAILED", `cf auth failed: ${String(lastError)}`);
}

export async function cfLogin(
  apiEndpoint: string,
  email: string,
  password: string,
  context: CfExecContext,
): Promise<void> {
  try {
    await cfApi(apiEndpoint, context);
    await cfAuth(email, password, context);
  } catch (err: unknown) {
    if (err instanceof CfDebuggerError) {
      throw new CfDebuggerError("CF_LOGIN_FAILED", err.message, err.stderr);
    }
    throw err;
  }
}

export async function cfTarget(
  org: string,
  space: string,
  context: CfExecContext,
): Promise<void> {
  try {
    await runCf(["target", "-o", org, "-s", space], context);
  } catch (err: unknown) {
    if (err instanceof CfDebuggerError) {
      throw new CfDebuggerError("CF_TARGET_FAILED", err.message, err.stderr);
    }
    throw err;
  }
}

export async function cfAppExists(appName: string, context: CfExecContext): Promise<boolean> {
  try {
    await runCf(["app", appName], context);
    return true;
  } catch (err: unknown) {
    const stderr = (err as CfDebuggerError).stderr ?? "";
    if (stderr.toLowerCase().includes("not found")) {
      return false;
    }
    throw err;
  }
}

export async function cfSshEnabled(appName: string, context: CfExecContext): Promise<boolean> {
  try {
    const stdout = await runCf(["ssh-enabled", appName], context);
    return stdout.toLowerCase().includes("ssh support is enabled");
  } catch {
    return false;
  }
}

export async function cfEnableSsh(appName: string, context: CfExecContext): Promise<void> {
  try {
    await runCf(["enable-ssh", appName], context);
  } catch (err: unknown) {
    if (err instanceof CfDebuggerError) {
      throw new CfDebuggerError("SSH_NOT_ENABLED", err.message, err.stderr);
    }
    throw err;
  }
}

export async function cfRestartApp(appName: string, context: CfExecContext): Promise<void> {
  await runCf(["restart", appName], context);
}

export async function cfApps(context: CfExecContext): Promise<readonly string[]> {
  const stdout = await runCf(["apps"], context);
  return parseAppNames(stdout);
}

export async function cfOrgs(context: CfExecContext): Promise<readonly string[]> {
  const stdout = await runCf(["orgs"], context);
  return parseNameTable(stdout);
}

export async function cfSpaces(context: CfExecContext): Promise<readonly string[]> {
  const stdout = await runCf(["spaces"], context);
  return parseNameTable(stdout);
}

export async function readCurrentCfTarget(
  options: CurrentCfTargetReadOptions = {},
): Promise<CurrentCfTarget | undefined> {
  try {
    const { stdout } = await execFileAsync(options.command ?? process.env["CF_DEBUGGER_CF_BIN"] ?? "cf", ["target"], {
      env: options.env ?? process.env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeoutMs ?? CURRENT_TARGET_TIMEOUT_MS,
    });
    return parseCurrentCfTarget(stdout);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CfDebuggerError("CF_TARGET_FAILED", `cf target failed: ${message}`);
  }
}

export function parseCurrentCfTarget(stdout: string): CurrentCfTarget | undefined {
  const fields = parseTargetFields(stdout);
  const apiEndpoint = fields.get("api endpoint");
  const org = fields.get("org");
  const space = fields.get("space");
  if (!isPresent(apiEndpoint) || !isPresent(org) || !isPresent(space)) {
    return undefined;
  }

  const region = regionKeyForApiEndpoint(apiEndpoint);
  return {
    apiEndpoint,
    ...(region === undefined ? {} : { region }),
    org,
    space,
  };
}

export function requireCurrentCfRegion(
  target: Pick<CurrentCfTarget, "apiEndpoint" | "region">,
  instruction = "Pass --region explicitly.",
): string {
  if (target.region !== undefined) {
    return target.region;
  }
  throw new CfDebuggerError(
    "CF_TARGET_FAILED",
    `Current CF API endpoint "${target.apiEndpoint}" does not match a known SAP region. ${instruction}`,
  );
}

function parseTargetFields(stdout: string): Map<string, string> {
  return new Map(
    stdout
      .split("\n")
      .map((line): readonly [string, string] | undefined => {
        const separator = line.indexOf(":");
        if (separator < 0) {
          return undefined;
        }
        return [
          line.slice(0, separator).trim().toLowerCase(),
          line.slice(separator + 1).trim(),
        ];
      })
      .filter((field): field is readonly [string, string] => field !== undefined),
  );
}

function regionKeyForApiEndpoint(apiEndpoint: string): string | undefined {
  const normalized = normalizeApiEndpoint(apiEndpoint);
  return listKnownRegionKeys().find((key) => normalizeApiEndpoint(resolveApiEndpoint(key)) === normalized);
}

function normalizeApiEndpoint(apiEndpoint: string): string {
  return apiEndpoint.trim().replace(/\/+$/, "").toLowerCase();
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}
