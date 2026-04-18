import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { CfDebuggerError } from "./types.js";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;
const CF_CLI_TIMEOUT_MS = 30_000;
const CF_RESTART_TIMEOUT_MS = 120_000;
const CF_SSH_SIGNAL_TIMEOUT_MS = 15_000;
const CF_AUTH_MAX_ATTEMPTS = 3;

export interface CfExecContext {
  readonly cfHome: string;
  readonly command?: string;
}

function buildEnv(cfHome: string): NodeJS.ProcessEnv {
  return { ...process.env, CF_HOME: cfHome };
}

function resolveBin(context: CfExecContext): string {
  return context.command ?? process.env["CF_DEBUGGER_CF_BIN"] ?? "cf";
}

async function runCf(
  args: readonly string[],
  context: CfExecContext,
  timeoutMs: number = CF_CLI_TIMEOUT_MS,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(resolveBin(context), [...args], {
      env: buildEnv(context.cfHome),
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
    });
    return stdout;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    const stderr = e.stderr?.trim() ?? "";
    throw new CfDebuggerError(
      "CF_CLI_FAILED",
      `cf ${args.join(" ")} failed: ${stderr.length > 0 ? stderr : e.message}`,
      stderr,
    );
  }
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
  await runCf(["restart", appName], context, CF_RESTART_TIMEOUT_MS);
}

export interface CfSshSignalResult {
  readonly exitCode: number | null;
  readonly stderr: string;
}

export async function cfSshOneShot(
  appName: string,
  command: string,
  context: CfExecContext,
): Promise<CfSshSignalResult> {
  return await new Promise<CfSshSignalResult>((resolve) => {
    const child = spawn(resolveBin(context), ["ssh", appName, "-c", command], {
      env: buildEnv(context.cfHome),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrBuf = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        child.kill();
      } catch {
        // already gone
      }
      resolve({ exitCode: null, stderr: stderrBuf });
    }, CF_SSH_SIGNAL_TIMEOUT_MS);

    child.stderr.on("data", (data: Buffer | string) => {
      stderrBuf += data.toString();
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode: code, stderr: stderrBuf });
    });

    child.on("error", (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode: null, stderr: err.message });
    });
  });
}

export function isSshDisabledError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return lower.includes("not authorized") || lower.includes("ssh support is disabled");
}

export function spawnSshTunnel(
  appName: string,
  localPort: number,
  remotePort: number,
  context: CfExecContext,
): ReturnType<typeof spawn> {
  const tunnelArg = `${localPort.toString()}:localhost:${remotePort.toString()}`;
  const isWindows = process.platform === "win32";
  return spawn(resolveBin(context), ["ssh", appName, "-N", "-L", tunnelArg], {
    env: buildEnv(context.cfHome),
    shell: isWindows,
    detached: !isWindows,
  });
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
    const first = trimmed.split(/\s+/)[0];
    if (first !== undefined && first.length > 0) {
      apps.push(first);
    }
  }
  return apps;
}

export async function cfApps(context: CfExecContext): Promise<readonly string[]> {
  const stdout = await runCf(["apps"], context);
  return parseAppNames(stdout);
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

export async function cfOrgs(context: CfExecContext): Promise<readonly string[]> {
  const stdout = await runCf(["orgs"], context);
  return parseNameTable(stdout);
}

export async function cfSpaces(context: CfExecContext): Promise<readonly string[]> {
  const stdout = await runCf(["spaces"], context);
  return parseNameTable(stdout);
}
