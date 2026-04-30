import {
  spawn,
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdir } from "node:fs/promises";
import process from "node:process";
import type { Readable } from "node:stream";

import { CfExplorerError } from "./errors.js";
import { buildRedactionRules, redactText } from "./redaction.js";
import { resolveApiEndpoint, resolveCredentials } from "./target.js";
import type { ExplorerCredentials, ExplorerRuntimeOptions, ExplorerTarget } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const RESTART_TIMEOUT_MS = 120_000;

export interface CfCommandContext {
  readonly cfBin?: string;
  readonly cfHomeDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly credentials?: ExplorerCredentials;
  readonly signal?: AbortSignal;
}

export interface CfRunOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly redactValues?: readonly string[];
}

export interface CfRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly truncated: boolean;
}

export interface PreparedCfSession {
  readonly context: CfCommandContext;
  readonly target: ExplorerTarget;
}

function resolveCfBin(context: CfCommandContext): string {
  return context.cfBin ?? context.env?.["CF_EXPLORER_CF_BIN"] ?? process.env["CF_EXPLORER_CF_BIN"] ?? "cf";
}

function isNodeScript(command: string): boolean {
  return /\.(?:c|m)?js$/i.test(command);
}

function resolveSpawnCommand(context: CfCommandContext): {
  readonly bin: string;
  readonly argsPrefix: readonly string[];
} {
  const command = resolveCfBin(context);
  return isNodeScript(command) ? { bin: process.execPath, argsPrefix: [command] } : { bin: command, argsPrefix: [] };
}

function buildChildEnv(
  context: CfCommandContext,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env = { ...process.env, ...context.env };
  delete env["SAP_EMAIL"];
  delete env["SAP_PASSWORD"];
  return { ...env, ...overrides, CF_HOME: context.cfHomeDir };
}

function describeCfCommand(args: readonly string[]): string {
  const [command] = args;
  if (command === "auth") {
    return "cf auth";
  }
  if (command === "ssh") {
    return describeCfSshCommand(args);
  }
  return `cf ${args.join(" ")}`;
}

function describeCfSshCommand(args: readonly string[]): string {
  const app = args[1] ?? "<app>";
  const processIndex = args.indexOf("--process");
  const instanceIndex = args.indexOf("-i");
  const processName = processIndex >= 0 ? args[processIndex + 1] : undefined;
  const instance = instanceIndex >= 0 ? args[instanceIndex + 1] : undefined;
  return [
    "cf ssh",
    app,
    processName === undefined ? "" : `--process ${processName}`,
    instance === undefined ? "" : `-i ${instance}`,
    "-c [remote script]",
  ].filter((part) => part.length > 0).join(" ");
}

function errorCodeForCommand(args: readonly string[], stderr: string): CfExplorerError["code"] {
  const command = args[0] ?? "";
  const lower = stderr.toLowerCase();
  if (command === "auth") {
    return "CF_LOGIN_FAILED";
  }
  if (command === "target") {
    return "CF_TARGET_FAILED";
  }
  if (command === "app" && lower.includes("not found")) {
    return "APP_NOT_FOUND";
  }
  if (command === "ssh" && isSshDisabledMessage(stderr)) {
    return "SSH_DISABLED";
  }
  return "REMOTE_COMMAND_FAILED";
}

function createProcessError(
  args: readonly string[],
  result: CfRunResult,
  redactionRules: ReturnType<typeof buildRedactionRules>,
): CfExplorerError {
  const detail = redactText(result.stderr.trim() || result.stdout.trim(), redactionRules);
  const command = describeCfCommand(args);
  const message = detail.length > 0 ? `${command} failed: ${detail}` : `${command} failed.`;
  return new CfExplorerError(errorCodeForCommand(args, detail), message, detail);
}

function appendBounded(
  current: string,
  chunk: Buffer | string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  const next = `${current}${chunk.toString()}`;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) {
    return { text: next, truncated: false };
  }
  return { text: truncateUtf8(next, maxBytes), truncated: true };
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    output += character;
    bytes += characterBytes;
  }
  return output;
}

export async function runCfCommand(
  args: readonly string[],
  context: CfCommandContext,
  options: CfRunOptions = {},
): Promise<CfRunResult> {
  const command = resolveSpawnCommand(context);
  const startedAt = Date.now();
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const child = spawn(command.bin, [...command.argsPrefix, ...args], {
    env: buildChildEnv(context),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return await collectCfResult(child, args, context, startedAt, maxBytes, options);
}

async function collectCfResult(
  child: ChildProcessByStdio<null, Readable, Readable>,
  args: readonly string[],
  context: CfCommandContext,
  startedAt: number,
  maxBytes: number,
  options: CfRunOptions,
): Promise<CfRunResult> {
  return await new Promise<CfRunResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const redactionRules = buildRedactionRules(context.credentials, options.redactValues);
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new CfExplorerError("REMOTE_COMMAND_FAILED", `${describeCfCommand(args)} timed out.`));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const abort = (): void => {
      child.kill("SIGTERM");
      reject(new CfExplorerError("ABORTED", "Operation aborted by caller."));
    };
    context.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer | string) => {
      const result = appendBounded(stdout, chunk, maxBytes);
      stdout = result.text;
      truncated ||= result.truncated;
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const result = appendBounded(stderr, chunk, maxBytes);
      stderr = result.text;
      truncated ||= result.truncated;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", abort);
      reject(new CfExplorerError("REMOTE_COMMAND_FAILED", redactText(error.message, redactionRules)));
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", abort);
      const result = { stdout, stderr, exitCode, durationMs: Date.now() - startedAt, truncated };
      if (exitCode === 0) {
        resolve(result);
        return;
      }
      reject(createProcessError(args, result, redactionRules));
    });
  });
}

export async function prepareCfCliSession(
  target: ExplorerTarget,
  cfHomeDir: string,
  runtime: ExplorerRuntimeOptions = {},
): Promise<PreparedCfSession> {
  const credentials = resolveCredentials(runtime);
  const context: CfCommandContext = {
    cfHomeDir,
    credentials,
    ...(runtime.cfBin === undefined ? {} : { cfBin: runtime.cfBin }),
    ...(runtime.env === undefined ? {} : { env: runtime.env }),
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  };
  await mkdir(cfHomeDir, { recursive: true, mode: 0o700 });
  await runCfCommand(["api", resolveApiEndpoint(target)], context, runtime);
  await runCfAuth(credentials, context, runtime);
  await runCfCommand(["target", "-o", target.org, "-s", target.space], context, runtime);
  return { context, target };
}

async function runCfAuth(
  credentials: ExplorerCredentials,
  context: CfCommandContext,
  runtime: ExplorerRuntimeOptions,
): Promise<void> {
  const authContext = {
    ...context,
    env: {
      ...context.env,
      CF_USERNAME: credentials.email,
      CF_PASSWORD: credentials.password,
    },
  };
  await runCfCommand(["auth"], authContext, runtime);
}

export async function cfApp(target: ExplorerTarget, context: CfCommandContext): Promise<string> {
  const result = await runCfCommand(["app", target.app], context);
  return result.stdout;
}

export async function cfSshEnabled(
  target: ExplorerTarget,
  context: CfCommandContext,
): Promise<boolean> {
  const result = await runCfCommand(["ssh-enabled", target.app], context);
  return result.stdout.toLowerCase().includes("enabled");
}

export async function cfEnableSsh(target: ExplorerTarget, context: CfCommandContext): Promise<void> {
  await runCfCommand(["enable-ssh", target.app], context);
}

export async function cfRestartApp(target: ExplorerTarget, context: CfCommandContext): Promise<void> {
  await runCfCommand(["restart", target.app], context, { timeoutMs: RESTART_TIMEOUT_MS });
}

export async function cfSshOneShot(
  target: ExplorerTarget,
  command: string,
  context: CfCommandContext,
  processName: string,
  instance: number,
  options: CfRunOptions = {},
): Promise<CfRunResult> {
  const args = [
    "ssh",
    target.app,
    "--disable-pseudo-tty",
    "--process",
    processName,
    "-i",
    instance.toString(),
    "-c",
    command,
  ];
  return await runCfCommand(args, context, options);
}

export function spawnPersistentSshShell(
  target: ExplorerTarget,
  context: CfCommandContext,
  processName: string,
  instance: number,
): ChildProcessWithoutNullStreams {
  const command = resolveSpawnCommand(context);
  const args = [
    ...command.argsPrefix,
    "ssh",
    target.app,
    "--disable-pseudo-tty",
    "--process",
    processName,
    "-i",
    instance.toString(),
    "-c",
    "sh",
  ];
  return spawn(command.bin, args, {
    env: buildChildEnv(context),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function isSshDisabledMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("not authorized") || lower.includes("ssh support is disabled");
}

export const internals = {
  buildChildEnv,
  describeCfCommand,
  resolveSpawnCommand,
};
