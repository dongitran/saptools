import { execFile, type ExecFileOptionsWithBufferEncoding } from "node:child_process";
import { promisify } from "node:util";

import type { CfExecContext } from "./types.js";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;

const REMOTE_FILE_SENTINEL = "__SAPTOOLS_CF_EXPORT_FILE_CONTENT__";

function resolveCfCommand(context?: CfExecContext): string {
  return context?.command ?? process.env["CF_EXPORT_CF_BIN"] ?? "cf";
}

function resolveCfEnv(context?: CfExecContext): NodeJS.ProcessEnv {
  const env = context?.env ? { ...process.env, ...context.env } : { ...process.env };
  delete env["SAP_EMAIL"];
  delete env["SAP_PASSWORD"];
  return env;
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

function sanitizeCfErrorDetail(
  detail: string,
  args: readonly string[],
  sensitiveValues: readonly string[] = [],
): string {
  const authArgs = args[0] === "auth" ? args.slice(1) : [];
  const values = [...authArgs, ...sensitiveValues];
  return values.reduce((current, value) => redactSensitiveValue(current, value), detail);
}

function errorDetailFrom(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const detail = e.stderr ?? e.message;
    return Buffer.isBuffer(detail) ? detail.toString("utf8") : (detail ?? "");
  }
  return String(err);
}

function withSensitiveEnv(
  context: CfExecContext | undefined,
  env: NodeJS.ProcessEnv,
  sensitiveValues: readonly string[],
): CfExecContext {
  return {
    ...context,
    env: { ...context?.env, ...env },
    sensitiveValues: [...(context?.sensitiveValues ?? []), ...sensitiveValues],
  };
}

async function runCf(args: readonly string[], context?: CfExecContext): Promise<string> {
  const cmd = resolveCfCommand(context);
  const isScript = cmd.endsWith(".mjs") || cmd.endsWith(".js");
  const file = isScript ? "node" : cmd;
  const allArgs = isScript ? [cmd, ...args] : [...args];
  try {
    const { stdout } = await execFileAsync(file, allArgs, {
      env: resolveCfEnv(context),
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch (err) {
    const command = describeCfCommand(args);
    const detail = sanitizeCfErrorDetail(errorDetailFrom(err), args, context?.sensitiveValues);
    throw new Error(`${command} failed: ${detail}`, { cause: err });
  }
}

async function runCfBuffer(
  args: readonly string[],
  context?: CfExecContext,
): Promise<Buffer> {
  const cmd = resolveCfCommand(context);
  const isScript = cmd.endsWith(".mjs") || cmd.endsWith(".js");
  const file = isScript ? "node" : cmd;
  const allArgs = isScript ? [cmd, ...args] : [...args];
  const options: ExecFileOptionsWithBufferEncoding = {
    env: resolveCfEnv(context),
    maxBuffer: MAX_BUFFER,
    encoding: "buffer",
  };
  try {
    const { stdout } = await execFileAsync(file, allArgs, options);
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch (err) {
    const command = describeCfCommand(args);
    const detail = sanitizeCfErrorDetail(errorDetailFrom(err), args, context?.sensitiveValues);
    throw new Error(`${command} failed: ${detail}`, { cause: err });
  }
}

export async function cfApi(apiEndpoint: string, context?: CfExecContext): Promise<void> {
  await runCf(["api", apiEndpoint], context);
}

export async function cfAuth(
  email: string,
  password: string,
  context?: CfExecContext,
): Promise<void> {
  const authContext = withSensitiveEnv(
    context,
    {
      CF_USERNAME: email,
      CF_PASSWORD: password,
    },
    [email, password],
  );
  await runCf(["auth"], authContext);
}

export async function cfTargetSpace(
  org: string,
  space: string,
  context?: CfExecContext,
): Promise<void> {
  await runCf(["target", "-o", org, "-s", space], context);
}

export async function cfAppGuid(appName: string, context?: CfExecContext): Promise<string> {
  const stdout = await runCf(["app", appName, "--guid"], context);
  const guid = stdout.trim();
  if (guid.length === 0) {
    throw new Error(`CF returned an empty app GUID for "${appName}".`);
  }
  return guid;
}

export async function cfCurl(path: string, context?: CfExecContext): Promise<string> {
  return await runCf(["curl", path], context);
}

export async function cfSsh(
  appName: string,
  command: string,
  context?: CfExecContext,
): Promise<string> {
  return await runCf(["ssh", appName, "--disable-pseudo-tty", "-c", command], context);
}

export async function cfSshBuffer(
  appName: string,
  command: string,
  context?: CfExecContext,
): Promise<Buffer> {
  return await runCfBuffer(["ssh", appName, "--disable-pseudo-tty", "-c", command], context);
}

export async function cfSshEnabled(appName: string, context?: CfExecContext): Promise<boolean> {
  try {
    const stdout = await runCf(["ssh-enabled", appName], context);
    return stdout.toLowerCase().includes("ssh support is enabled");
  } catch {
    return false;
  }
}

export async function cfEnableSsh(appName: string, context?: CfExecContext): Promise<void> {
  await runCf(["enable-ssh", appName], context);
}

export async function cfRestartApp(appName: string, context?: CfExecContext): Promise<void> {
  await runCf(["restart", appName], context);
}

export async function ensureSshEnabled(appName: string, context?: CfExecContext): Promise<void> {
  const status = await runCf(["ssh-enabled", appName], context);
  if (status.toLowerCase().includes("ssh support is enabled")) {
    return;
  }

  await runCf(["enable-ssh", appName], context);
  await runCf(["restart", appName], context);

  // Wait for SSH to become available after restart (CF can take a few seconds)
  const maxAttempts = 6;
  const delayMs = 3000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await runCf(["ssh", appName, "--disable-pseudo-tty", "-c", "echo ready"], context);
      return;
    } catch {
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  // If still not ready, let subsequent ssh calls fail naturally with clear error
}

export function buildRemoteFilePaths(fileName: string, remoteRoot: string | undefined): readonly string[] {
  const paths: string[] = [];
  const normalized = remoteRoot?.trim().replace(/\/+$/, "");
  if (normalized !== undefined && normalized.length > 0) {
    paths.push(`${normalized}/${fileName}`);
  }
  const fallbacks = [`/home/vcap/app/${fileName}`, fileName];
  for (const fb of fallbacks) {
    if (!paths.includes(fb)) {
      paths.push(fb);
    }
  }
  return paths;
}

export function buildCatCommand(remotePath: string): string {
  const quoted = `'${remotePath.replaceAll("'", "'\\''")}'`;
  return [
    `if [ -f ${quoted} ]; then`,
    `printf '%s\\n' ${quotedForSentinel()};`,
    `cat ${quoted};`,
    "else exit 66; fi",
  ].join(" ");
}

function quotedForSentinel(): string {
  // Sentinel is a constant known only to us; no user content can start with it after trim.
  const s = REMOTE_FILE_SENTINEL;
  return `'${s.replaceAll("'", "'\\''")}'`;
}

export const REMOTE_CONTENT_SENTINEL = REMOTE_FILE_SENTINEL;

export function parseRemoteFileContent(stdout: string): string | null {
  const prefix = `${REMOTE_FILE_SENTINEL}\n`;
  if (stdout.startsWith(prefix)) {
    return stdout.slice(prefix.length);
  }
  return null;
}

export const internals = {
  runCf,
  describeCfCommand,
  sanitizeCfErrorDetail,
};
