import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;

export interface CfExecError extends Error {
  readonly stderr?: string;
  readonly stdout?: string;
  readonly code?: number | string;
}

async function cf(args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("cf", [...args], { maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (err) {
    const e = err as CfExecError;
    const msg = `cf ${args.join(" ")} failed: ${e.stderr ?? e.message}`;
    throw new Error(msg, { cause: err });
  }
}

export async function cfApi(apiEndpoint: string): Promise<void> {
  await cf(["api", apiEndpoint]);
}

export async function cfAuth(email: string, password: string): Promise<void> {
  await cf(["auth", email, password]);
}

export async function cfOrgs(): Promise<readonly string[]> {
  const stdout = await cf(["orgs"]);
  return parseNameTable(stdout);
}

export async function cfTargetOrg(org: string): Promise<void> {
  await cf(["target", "-o", org]);
}

export async function cfTargetSpace(org: string, space: string): Promise<void> {
  await cf(["target", "-o", org, "-s", space]);
}

export async function cfSpaces(): Promise<readonly string[]> {
  const stdout = await cf(["spaces"]);
  return parseNameTable(stdout);
}

export async function cfApps(): Promise<readonly string[]> {
  const stdout = await cf(["apps"]);
  return parseAppNames(stdout);
}

export async function cfEnv(appName: string): Promise<string> {
  return await cf(["env", appName]);
}

export async function cfCurl(path: string): Promise<string> {
  return await cf(["curl", path]);
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
