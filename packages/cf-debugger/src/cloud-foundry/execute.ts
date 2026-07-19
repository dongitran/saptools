import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { CfDebuggerError } from "../types.js";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;
export const DEFAULT_CF_COMMAND_TIMEOUT_MS = 300_000;
const REDACTED_ARG = "<redacted>";
const MAX_RETRIES = 3;

export interface CfExecContext {
  readonly cfHome: string;
  readonly command?: string;
  readonly signal?: AbortSignal;
}

export interface CfRunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly sensitiveValues?: readonly string[];
  readonly timeoutMs?: number;
}

interface CfFailureDetails {
  readonly code: string | undefined;
  readonly killed: boolean;
  readonly message: string;
  readonly stderr: string | undefined;
  readonly stdout: string | undefined;
}

interface ResolvedCfRunOptions {
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly redactionValues: readonly string[];
  readonly timeoutMs: number;
}

export function buildEnv(cfHome: string): NodeJS.ProcessEnv {
  return { ...process.env, CF_HOME: cfHome };
}

export function resolveBin(context: CfExecContext): string {
  return context.command ?? process.env["CF_DEBUGGER_CF_BIN"] ?? "cf";
}

function sensitiveArgs(args: readonly string[]): readonly string[] {
  if (args[0] !== "auth") {
    return [];
  }
  return args.slice(1).filter((arg) => arg.length > 0);
}

function redactText(text: string, values: readonly string[]): string {
  return values.reduce((current, value) => current.split(value).join(REDACTED_ARG), text);
}

function normalizeSensitiveValues(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
    .sort((left, right) => right.length - left.length);
}

function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new CfDebuggerError("ABORTED", "Operation aborted by caller"));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CfDebuggerError("ABORTED", "Operation aborted by caller"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function formatArgsForError(args: readonly string[]): string {
  if (args[0] !== "auth") {
    return args.join(" ");
  }
  return args.map((arg, index) => (index === 0 ? arg : REDACTED_ARG)).join(" ");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readFailureDetails(error: unknown): CfFailureDetails {
  const errorObject = typeof error === "object" && error !== null ? error : undefined;
  const field = (key: string): unknown => errorObject === undefined ? undefined : Reflect.get(errorObject, key);
  return {
    code: optionalString(field("code")),
    killed: field("killed") === true,
    message: error instanceof Error ? error.message : String(error),
    stderr: optionalString(field("stderr")),
    stdout: optionalString(field("stdout")),
  };
}

function isTransientNetworkError(error: CfFailureDetails): boolean {
  if (error.killed && error.code === undefined) {
    // execFile reports a timeout as a killed process without an errno code.
    return true;
  }

  const code = error.code ?? "";
  const networkCodes = ["ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"];
  if (networkCodes.includes(code)) {
    return true;
  }

  const output = `${error.message} ${error.stderr ?? ""} ${error.stdout ?? ""}`.toLowerCase();
  const transientPhrases = [
    "error performing request",
    "timeout exceeded",
    "connection reset by peer",
    "service unavailable",
    "bad gateway",
    "gateway timeout",
    "dial tcp",
    "i/o timeout"
  ];
  if (transientPhrases.some((phrase) => output.includes(phrase))) {
    return true;
  }

  const transientRegexes = [/\b502\b/, /\b503\b/, /\b504\b/, /\btimeout\b/];
  return transientRegexes.some((regex) => regex.test(output));
}

function resolveRunOptions(
  args: readonly string[],
  input: number | CfRunOptions,
): ResolvedCfRunOptions {
  const options = typeof input === "number" ? { timeoutMs: input } : input;
  return {
    env: options.env,
    redactionValues: normalizeSensitiveValues([
      ...sensitiveArgs(args),
      ...(options.sensitiveValues ?? []),
    ]),
    timeoutMs: options.timeoutMs ?? DEFAULT_CF_COMMAND_TIMEOUT_MS,
  };
}

async function executeCfAttempt(
  args: readonly string[],
  context: CfExecContext,
  options: ResolvedCfRunOptions,
): Promise<string> {
  const { stdout } = await execFileAsync(resolveBin(context), [...args], {
    env: { ...buildEnv(context.cfHome), ...options.env },
    maxBuffer: MAX_BUFFER,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    timeout: options.timeoutMs,
  });
  return stdout;
}

function retryDelayMs(failure: CfFailureDetails, attempt: number): number | undefined {
  if (!isTransientNetworkError(failure) || attempt > MAX_RETRIES) {
    return undefined;
  }
  return Math.min(1000 * (2 ** (attempt - 1)), 10_000);
}

function createCfCliError(
  args: readonly string[],
  failure: CfFailureDetails,
  redactionValues: readonly string[],
): CfDebuggerError {
  const stderr = redactText(failure.stderr?.trim() ?? "", redactionValues);
  const fallbackMessage = redactText(failure.message, redactionValues);
  const detail = stderr.length > 0 ? stderr : fallbackMessage;
  return new CfDebuggerError(
    "CF_CLI_FAILED",
    `cf ${formatArgsForError(args)} failed: ${detail}`,
    stderr,
  );
}

export async function runCf(
  args: readonly string[],
  context: CfExecContext,
  input: number | CfRunOptions = {},
): Promise<string> {
  if (context.signal?.aborted) {
    throw new CfDebuggerError("ABORTED", "Operation aborted by caller");
  }
  const options = resolveRunOptions(args, input);
  let attempt = 0;

  for (;;) {
    try {
      return await executeCfAttempt(args, context, options);
    } catch (err: unknown) {
      attempt += 1;
      const failure = readFailureDetails(err);
      if (context.signal?.aborted || failure.code === "ABORT_ERR") {
        throw new CfDebuggerError("ABORTED", "Operation aborted by caller");
      }
      const delayMs = retryDelayMs(failure, attempt);
      if (delayMs !== undefined) {
        await waitForRetry(delayMs, context.signal);
        continue;
      }
      throw createCfCliError(args, failure, options.redactionValues);
    }
  }
}
