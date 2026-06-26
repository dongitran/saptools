import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { getAllRegions } from "../config/regions.js";
import type { AppNode, RegionKey } from "../types.js";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_CF_COMMAND_TIMEOUT_MS = 30_000;

export interface CfExecError extends Error {
  readonly stderr?: string;
  readonly stdout?: string;
  readonly code?: number | string;
}

export interface CfExecContext {
  readonly command?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

export interface CurrentCfTarget {
  readonly apiEndpoint: string;
  readonly regionKey?: RegionKey;
  readonly orgName: string;
  readonly spaceName: string;
}

interface CfInvocation {
  readonly bin: string;
  readonly argsPrefix: readonly string[];
}

function resolveCfInvocation(context?: CfExecContext): CfInvocation {
  const command = context?.command ?? process.env["CF_SYNC_CF_BIN"] ?? "cf";
  return isNodeScript(command)
    ? { bin: process.execPath, argsPrefix: [command] }
    : { bin: command, argsPrefix: [] };
}

function isNodeScript(command: string): boolean {
  return /\.(?:c|m)?js$/i.test(command);
}

function resolveCfEnv(context?: CfExecContext): NodeJS.ProcessEnv {
  return context?.env ? { ...process.env, ...context.env } : process.env;
}

function resolveCfTimeout(context?: CfExecContext): number {
  return context?.timeoutMs ?? DEFAULT_CF_COMMAND_TIMEOUT_MS;
}

function describeCfCommand(args: readonly string[]): string {
  const [command] = args;
  if (command === undefined) {
    return "cf";
  }

  if (command === "auth") {
    return "cf auth";
  }

  return `cf ${args.join(" ")}`;
}

function redactSensitiveValue(detail: string, value: string): string {
  if (value.length === 0) {
    return detail;
  }

  return detail.split(value).join("[REDACTED]");
}

function sanitizeCfErrorDetail(detail: string, args: readonly string[]): string {
  if (args[0] !== "auth") {
    return detail;
  }

  return args.slice(1).reduce((current, value) => redactSensitiveValue(current, value), detail);
}

async function cf(args: readonly string[], context?: CfExecContext): Promise<string> {
  try {
    const invocation = resolveCfInvocation(context);
    const { stdout } = await execFileAsync(invocation.bin, [...invocation.argsPrefix, ...args], {
      env: resolveCfEnv(context),
      maxBuffer: MAX_BUFFER,
      timeout: resolveCfTimeout(context),
    });
    return stdout;
  } catch (err) {
    const e = err as CfExecError;
    const command = describeCfCommand(args);
    const detail = sanitizeCfErrorDetail(e.stderr ?? e.message, args);
    const msg = `${command} failed: ${detail}`;
    throw new Error(msg, { cause: err });
  }
}

export async function cfApi(apiEndpoint: string, context?: CfExecContext): Promise<void> {
  await cf(["api", apiEndpoint], context);
}

export async function cfAuth(email: string, password: string, context?: CfExecContext): Promise<void> {
  await cf(["auth", email, password], context);
}

export async function cfOrgs(context?: CfExecContext): Promise<readonly string[]> {
  const stdout = await cf(["orgs"], context);
  return parseNameTable(stdout);
}

export async function cfTargetOrg(org: string, context?: CfExecContext): Promise<void> {
  await cf(["target", "-o", org], context);
}

export async function cfTargetSpace(
  org: string,
  space: string,
  context?: CfExecContext,
): Promise<void> {
  await cf(["target", "-o", org, "-s", space], context);
}

export async function cfSpaces(context?: CfExecContext): Promise<readonly string[]> {
  const stdout = await cf(["spaces"], context);
  return parseNameTable(stdout);
}

export async function cfApps(context?: CfExecContext): Promise<readonly string[]> {
  const stdout = await cf(["apps"], context);
  return parseAppNames(stdout);
}

export async function cfAppDetails(context?: CfExecContext): Promise<readonly AppNode[]> {
  const stdout = await cf(["apps"], context);
  return parseAppDetails(stdout);
}

export async function cfEnv(appName: string, context?: CfExecContext): Promise<string> {
  return await cf(["env", appName], context);
}

export async function cfCurl(path: string, context?: CfExecContext): Promise<string> {
  return await cf(["curl", path], context);
}

export async function readCurrentCfTarget(context?: CfExecContext): Promise<CurrentCfTarget | undefined> {
  return parseCfTargetOutput(await cf(["target"], context));
}

export function parseCfTargetOutput(stdout: string): CurrentCfTarget | undefined {
  const fields = parseCfTargetFields(stdout);
  const apiEndpoint = fields.get("api endpoint");
  const orgName = fields.get("org");
  const spaceName = fields.get("space");
  if (
    apiEndpoint === undefined ||
    orgName === undefined ||
    spaceName === undefined ||
    apiEndpoint.length === 0 ||
    orgName.length === 0 ||
    spaceName.length === 0
  ) {
    return undefined;
  }

  const regionKey = regionKeyForApiEndpoint(apiEndpoint);
  return {
    apiEndpoint,
    ...(regionKey === undefined ? {} : { regionKey }),
    orgName,
    spaceName,
  };
}

export function regionKeyForApiEndpoint(apiEndpoint: string): RegionKey | undefined {
  const normalized = normalizeApiEndpoint(apiEndpoint);
  return getAllRegions().find((region) => normalizeApiEndpoint(region.apiEndpoint) === normalized)?.key;
}

export function requireCurrentCfRegionKey(
  target: Pick<CurrentCfTarget, "apiEndpoint" | "regionKey">,
  instruction = "Pass --region explicitly.",
): RegionKey {
  if (target.regionKey !== undefined) {
    return target.regionKey;
  }
  throw new Error(
    `Current CF API endpoint "${target.apiEndpoint}" does not match a known SAP region. ${instruction}`,
  );
}

export function formatCurrentCfAppSelector(target: CurrentCfTarget, appName: string): string {
  const trimmedAppName = appName.trim();
  if (trimmedAppName.length === 0) {
    throw new Error("App name is required.");
  }
  const regionKey = requireCurrentCfRegionKey(
    target,
    "Pass a full region/org/space/app selector.",
  );
  return `${regionKey}/${target.orgName}/${target.spaceName}/${trimmedAppName}`;
}

export function parseNameTable(stdout: string): readonly string[] {
  const lines = stdout.split("\n");
  const headerIdx = lines.findIndex((l) => l.trim() === "name");

  if (headerIdx === -1) {
    return [];
  }

  return lines
    .slice(headerIdx + 1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function parseAppNames(stdout: string): readonly string[] {
  return parseAppDetails(stdout).map((app) => app.name);
}

function parseInstanceCounts(value: string | undefined): {
  readonly runningInstances: number;
  readonly totalInstances: number;
} | undefined {
  if (!value) {
    return undefined;
  }

  const regex = /(?:^|\b)(\d+)\/(\d+)/g;
  let runningInstances = 0;
  let totalInstances = 0;
  let matched = false;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(value)) !== null) {
    matched = true;
    runningInstances += Number.parseInt(match[1] ?? "0", 10);
    totalInstances += Number.parseInt(match[2] ?? "0", 10);
  }

  return matched ? { runningInstances, totalInstances } : undefined;
}

function parseRoutes(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const routes = value
    .split(",")
    .map((route) => route.trim())
    .filter((route) => route.length > 0);

  return routes;
}

function buildAppDetail(parts: readonly string[]): AppNode | undefined {
  const name = parts[0]?.trim();
  if (!name) {
    return undefined;
  }

  const requestedState = parts[1]?.trim();
  const instanceCounts = parseInstanceCounts(parts[2]?.trim());
  const routes = requestedState ? parseRoutes(parts.slice(3).join(" ").trim()) : undefined;
  const app: AppNode = { name };

  return {
    ...app,
    ...(requestedState ? { requestedState } : {}),
    ...(instanceCounts ?? {}),
    ...(routes ? { routes } : {}),
  };
}

export function parseAppDetails(stdout: string): readonly AppNode[] {
  const apps: AppNode[] = [];
  let pastHeader = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();

    if (!pastHeader) {
      if (trimmed.startsWith("name")) {
        pastHeader = true;
      }
      continue;
    }

    if (trimmed.length === 0) {
      continue;
    }

    const app = buildAppDetail(trimmed.split(/\s{2,}/));
    if (app !== undefined) {
      apps.push(app);
    }
  }

  return apps;
}

function parseCfTargetFields(stdout: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key.length > 0 && value.length > 0) {
      fields.set(key, value);
    }
  }
  return fields;
}

function normalizeApiEndpoint(apiEndpoint: string): string {
  return apiEndpoint.trim().replace(/\/+$/, "").toLowerCase();
}
