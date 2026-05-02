import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AppNode } from "../types.js";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;

export interface CfExecError extends Error {
  readonly stderr?: string;
  readonly stdout?: string;
  readonly code?: number | string;
}

export interface CfExecContext {
  readonly command?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function resolveCfCommand(context?: CfExecContext): string {
  return context?.command ?? process.env["CF_SYNC_CF_BIN"] ?? "cf";
}

function resolveCfEnv(context?: CfExecContext): NodeJS.ProcessEnv {
  return context?.env ? { ...process.env, ...context.env } : process.env;
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
    const { stdout } = await execFileAsync(resolveCfCommand(context), [...args], {
      env: resolveCfEnv(context),
      maxBuffer: MAX_BUFFER,
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
