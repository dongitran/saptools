import { execFile, type ExecFileOptionsWithBufferEncoding } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;

export interface CfExecContext {
  readonly command?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sensitiveValues?: readonly string[];
}

export interface CfExecError extends Error {
  readonly stderr?: Buffer | string;
  readonly stdout?: Buffer | string;
  readonly code?: number | string;
}

function resolveCfCommand(context?: CfExecContext): string {
  return context?.command ?? process.env["CF_FILES_CF_BIN"] ?? "cf";
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

function errorDetailFrom(err: CfExecError): string {
  const detail = err.stderr ?? err.message;
  return Buffer.isBuffer(detail) ? detail.toString("utf8") : detail;
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
    const detail = sanitizeCfErrorDetail(errorDetailFrom(e), args, context?.sensitiveValues);
    throw new Error(`${command} failed: ${detail}`, { cause: err });
  }
}

async function cfBuffer(
  args: readonly string[],
  context?: CfExecContext,
  maxBuffer?: number,
): Promise<Buffer> {
  const options: ExecFileOptionsWithBufferEncoding = {
    env: resolveCfEnv(context),
    maxBuffer: maxBuffer ?? MAX_BUFFER,
    encoding: "buffer",
  };

  try {
    const { stdout } = await execFileAsync(resolveCfCommand(context), [...args], options);
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch (err) {
    const e = err as CfExecError;
    const command = describeCfCommand(args);
    const detail = sanitizeCfErrorDetail(errorDetailFrom(e), args, context?.sensitiveValues);
    throw new Error(`${command} failed: ${detail}`, { cause: err });
  }
}

export async function cfApi(apiEndpoint: string, context?: CfExecContext): Promise<void> {
  await cf(["api", apiEndpoint], context);
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
  await cf(["auth"], authContext);
}

export async function cfTargetSpace(
  org: string,
  space: string,
  context?: CfExecContext,
): Promise<void> {
  await cf(["target", "-o", org, "-s", space], context);
}

export async function cfEnv(appName: string, context?: CfExecContext): Promise<string> {
  return await cf(["env", appName], context);
}

export async function cfSsh(
  appName: string,
  command: string,
  context?: CfExecContext,
): Promise<string> {
  return await cf(["ssh", appName, "--disable-pseudo-tty", "-c", command], context);
}

export async function cfSshBuffer(
  appName: string,
  command: string,
  context?: CfExecContext,
  maxBuffer?: number,
): Promise<Buffer> {
  return await cfBuffer(
    ["ssh", appName, "--disable-pseudo-tty", "-c", command],
    context,
    maxBuffer,
  );
}

export const internals = {
  describeCfCommand,
  sanitizeCfErrorDetail,
  redactSensitiveValue,
};
