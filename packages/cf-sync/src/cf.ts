import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

async function cf(args: readonly string[], context?: CfExecContext): Promise<string> {
  try {
    const { stdout } = await execFileAsync(resolveCfCommand(context), [...args], {
      env: resolveCfEnv(context),
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch (err) {
    const e = err as CfExecError;
    const msg = `cf ${args.join(" ")} failed: ${e.stderr ?? e.message}`;
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
  const apps: string[] = [];
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

    const appName = trimmed.split(/\s+/)[0];

    if (appName !== undefined && appName.length > 0) {
      apps.push(appName);
    }
  }

  return apps;
}
