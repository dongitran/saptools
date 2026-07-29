import { listKnownRegionKeys, resolveApiEndpoint } from "../regions.js";
import { CfDebuggerError } from "../types.js";

import {
  type CfExecContext,
  executeFileBounded,
  runCf,
} from "./execute.js";

const CURRENT_TARGET_TIMEOUT_MS = 30_000;

function rethrowControlFlowError(error: unknown): void {
  if (
    error instanceof CfDebuggerError &&
    (
      error.code === "ABORTED" ||
      error.code === "CF_MUTATION_TIMEOUT" ||
      error.code === "STARTUP_TIMEOUT"
    )
  ) {
    throw error;
  }
}

export interface CurrentCfTargetReadOptions {
  readonly command?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface CurrentCfTarget {
  readonly apiEndpoint: string;
  readonly region?: string;
  readonly org: string;
  readonly space: string;
}

export async function cfApi(apiEndpoint: string, context: CfExecContext): Promise<void> {
  await runCf({
    args: ["api", apiEndpoint],
    retryPolicy: "retry-transient",
  }, context);
}

export async function cfAuth(
  email: string,
  password: string,
  context: CfExecContext,
): Promise<void> {
  try {
    await runCf({
      args: ["auth"],
      retryPolicy: "retry-transient",
    }, context, {
      env: { CF_PASSWORD: password, CF_USERNAME: email },
      sensitiveValues: [email, password],
    });
  } catch (error: unknown) {
    rethrowControlFlowError(error);
    if (error instanceof CfDebuggerError) {
      throw new CfDebuggerError(
        "CF_AUTH_FAILED",
        `${error.message}. Check SAP_EMAIL and SAP_PASSWORD before retrying.`,
        error.stderr,
      );
    }
    throw error;
  }
}

export async function cfLogin(
  apiEndpoint: string,
  email: string,
  password: string,
  context: CfExecContext,
): Promise<void> {
  try {
    await cfApi(apiEndpoint, context);
  } catch (error: unknown) {
    rethrowControlFlowError(error);
    if (error instanceof CfDebuggerError) {
      throw new CfDebuggerError("CF_LOGIN_FAILED", error.message, error.stderr);
    }
    throw error;
  }
  await cfAuth(email, password, context);
}

export async function cfTarget(
  org: string,
  space: string,
  context: CfExecContext,
): Promise<void> {
  try {
    await runCf({
      args: ["target", "-o", org, "-s", space],
      retryPolicy: "retry-transient",
    }, context);
  } catch (err: unknown) {
    rethrowControlFlowError(err);
    if (err instanceof CfDebuggerError) {
      throw new CfDebuggerError("CF_TARGET_FAILED", err.message, err.stderr);
    }
    throw err;
  }
}

export async function cfAppExists(appName: string, context: CfExecContext): Promise<boolean> {
  try {
    await runCf({
      args: ["app", appName],
      retryPolicy: "retry-transient",
    }, context);
    return true;
  } catch (err: unknown) {
    rethrowControlFlowError(err);
    const stderr = err instanceof CfDebuggerError ? err.stderr ?? "" : "";
    if (stderr.toLowerCase().includes("not found")) {
      return false;
    }
    throw err;
  }
}

export type SshEnablementState = "disabled" | "enabled" | "unknown";

export async function cfSshEnabled(
  appName: string,
  context: CfExecContext,
): Promise<SshEnablementState> {
  try {
    const stdout = await runCf({
      args: ["ssh-enabled", appName],
      retryPolicy: "retry-transient",
    }, context);
    const normalized = stdout.toLowerCase();
    if (normalized.includes("ssh support is enabled")) {
      return "enabled";
    }
    if (normalized.includes("ssh support is disabled")) {
      return "disabled";
    }
    return "unknown";
  } catch (err: unknown) {
    rethrowControlFlowError(err);
    return "unknown";
  }
}

export async function cfEnableSsh(appName: string, context: CfExecContext): Promise<void> {
  try {
    await runCf({
      args: ["enable-ssh", appName],
      retryPolicy: "mutation",
    }, context);
  } catch (err: unknown) {
    rethrowControlFlowError(err);
    if (err instanceof CfDebuggerError) {
      throw new CfDebuggerError("SSH_NOT_ENABLED", err.message, err.stderr);
    }
    throw err;
  }
}

export async function cfRestartApp(appName: string, context: CfExecContext): Promise<void> {
  await runCf({
    args: ["restart", appName],
    retryPolicy: "mutation",
  }, context);
}

export async function readCurrentCfTarget(
  options: CurrentCfTargetReadOptions = {},
): Promise<CurrentCfTarget | undefined> {
  try {
    const { stdout } = await executeFileBounded(
      options.command ?? process.env["CF_DEBUGGER_CF_BIN"] ?? "cf",
      ["target"],
      {
        env: { ...process.env, ...options.env, CF_COLOR: "false" },
        maxBuffer: 16 * 1024 * 1024,
        timeoutMs: options.timeoutMs ?? CURRENT_TARGET_TIMEOUT_MS,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    return parseCurrentCfTarget(stdout);
  } catch (error: unknown) {
    if (
      options.signal?.aborted === true ||
      (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ABORT_ERR")
    ) {
      throw new CfDebuggerError("ABORTED", "Current CF target discovery was aborted.");
    }
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

export function regionKeyForApiEndpoint(apiEndpoint: string): string | undefined {
  const normalized = normalizeApiEndpoint(apiEndpoint);
  const known = listKnownRegionKeys().find((key) => normalizeApiEndpoint(resolveApiEndpoint(key)) === normalized);
  if (known !== undefined) {
    return known;
  }
  return regionKeyFromSapApiEndpoint(normalized);
}

function normalizeApiEndpoint(apiEndpoint: string): string {
  return apiEndpoint.trim().replace(/\/+$/, "").toLowerCase();
}

export function regionKeyFromSapApiEndpoint(apiEndpoint: string): string | undefined {
  const match = /^https:\/\/api\.cf\.([a-z]{2}\d{2}(?:-\d{3})?)\.(hana\.ondemand\.com|platform\.sapcloud\.cn)$/.exec(apiEndpoint);
  const regionKey = match?.[1];
  const domain = match?.[2];
  if (regionKey === undefined || domain === undefined) {
    return undefined;
  }
  const expectedDomain = regionKey.startsWith("cn")
    ? "platform.sapcloud.cn"
    : "hana.ondemand.com";
  return domain === expectedDomain ? regionKey : undefined;
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}
