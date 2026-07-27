import { execFile } from "node:child_process";
import type {
  ChildProcess,
  ExecFileException,
} from "node:child_process";
import nodeProcess from "node:process";

import { CfDebuggerError } from "../types.js";

const MAX_BUFFER = 16 * 1024 * 1024;
export const DEFAULT_CF_COMMAND_TIMEOUT_MS = 60_000;
export const DEFAULT_CF_OPERATION_TIMEOUT_MS = 300_000;
const REDACTED_ARG = "<redacted>";
const MAX_RETRY_DELAY_MS = 10_000;

export interface CfRetryStatus {
  readonly attempt: number;
  readonly command: string;
  readonly delayMs: number;
  readonly remainingMs: number;
}

export interface CfExecContext {
  readonly cfHome: string;
  readonly command?: string;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
  readonly startupTimeoutMs?: number;
  readonly phase?: string;
  readonly onRetry?: (status: CfRetryStatus) => void;
  readonly sensitiveValues?: readonly string[];
  readonly onTunnelOutput?: (stream: "stderr" | "stdout", text: string) => void;
}

export interface CfRunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly sensitiveValues?: readonly string[];
  /** Maximum duration of one child execution. */
  readonly timeoutMs?: number;
  /** Overall budget when no startup deadline is supplied. */
  readonly retryBudgetMs?: number;
}

interface CfFailureDetails {
  readonly code: string | undefined;
  readonly killed: boolean;
  readonly message: string;
  readonly stderr: string | undefined;
}

interface ResolvedCfRunOptions {
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly redactionValues: readonly string[];
  readonly attemptTimeoutMs: number;
  readonly deadlineAt: number;
}

export interface BoundedExecFileOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly maxBuffer?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export function buildEnv(cfHome: string): NodeJS.ProcessEnv {
  return { ...nodeProcess.env, CF_COLOR: "false", CF_HOME: cfHome };
}

export function resolveBin(context: CfExecContext): string {
  return context.command ?? nodeProcess.env["CF_DEBUGGER_CF_BIN"] ?? "cf";
}

export function redactSensitiveText(text: string, values: readonly string[]): string {
  return normalizeSensitiveValues(values)
    .reduce((current, value) => current.split(value).join(REDACTED_ARG), text);
}

export function normalizeSensitiveValues(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
    .sort((left, right) => right.length - left.length);
}

function abortError(context: CfExecContext): CfDebuggerError {
  if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt) {
    const timeoutMs = context.startupTimeoutMs;
    const duration = timeoutMs === undefined ? "configured" : `${(timeoutMs / 1000).toString()}s`;
    return new CfDebuggerError(
      "STARTUP_TIMEOUT",
      `Debugger startup exceeded its ${duration} deadline during ${context.phase ?? "a CF command"}.`,
    );
  }
  return new CfDebuggerError("ABORTED", "Operation aborted by caller");
}

function waitForRetry(
  delayMs: number,
  context: CfExecContext,
): Promise<void> {
  if (context.signal?.aborted) {
    return Promise.reject(abortError(context));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(context));
    };
    const timer = setTimeout(() => {
      context.signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    context.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function formatArgsForError(
  args: readonly string[],
  sensitiveValues: readonly string[],
): string {
  // Authentication secrets are intentionally supplied only through the child environment.
  return redactSensitiveText(args.join(" "), sensitiveValues);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readFailureDetails(error: unknown): CfFailureDetails {
  const object = typeof error === "object" && error !== null ? error : undefined;
  const field = (key: string): unknown => object === undefined ? undefined : Reflect.get(object, key);
  return {
    code: optionalString(field("code")),
    killed: field("killed") === true,
    message: error instanceof Error ? error.message : String(error),
    stderr: optionalString(field("stderr")),
  };
}

function hasTransientDiagnostic(error: CfFailureDetails): boolean {
  // CF CLI transport failures sometimes have no errno. Inspect stderr only:
  // stdout can contain app names or payloads that merely mention these phrases.
  const diagnostic = error.stderr?.toLowerCase() ?? "";
  const phrases = [
    "error performing request",
    "connection reset by peer",
    "service unavailable",
    "bad gateway",
    "gateway timeout",
    "dial tcp",
    "i/o timeout",
  ];
  return phrases.some((phrase) => diagnostic.includes(phrase));
}

function isCredentialRejection(
  args: readonly string[],
  error: CfFailureDetails,
): boolean {
  if (args[0] !== "auth") {
    return false;
  }
  const diagnostic = `${error.stderr ?? ""} ${error.message}`.toLowerCase();
  const phrases = [
    "authentication failed",
    "credentials were rejected",
    "invalid credentials",
    "invalid email",
    "invalid password",
    "invalid username",
    "incorrect password",
    "not authorized",
    "unauthorized",
  ];
  return phrases.some((phrase) => diagnostic.includes(phrase)) ||
    /\b(?:401|403)\b/.test(diagnostic);
}

function isTransientNetworkError(
  error: CfFailureDetails,
  attemptTimedOut: boolean,
): boolean {
  if (attemptTimedOut) {
    // This is tied to our own execFile timeout, not arbitrary output mentioning a timeout.
    return true;
  }
  const networkCodes = [
    "ETIMEDOUT",
    "ECONNRESET",
    "ENOTFOUND",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
  ];
  return (error.code !== undefined && networkCodes.includes(error.code)) ||
    hasTransientDiagnostic(error);
}

function requirePositiveMilliseconds(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CfDebuggerError(
      "UNSAFE_INPUT",
      `${name} must be a positive safe integer.`,
    );
  }
  return value;
}

function resolveRunOptions(
  context: CfExecContext,
  input: number | CfRunOptions,
): ResolvedCfRunOptions {
  const options = typeof input === "number" ? { timeoutMs: input } : input;
  const retryBudgetMs = requirePositiveMilliseconds(
    options.retryBudgetMs ?? DEFAULT_CF_OPERATION_TIMEOUT_MS,
    "retryBudgetMs",
  );
  const attemptTimeoutMs = requirePositiveMilliseconds(
    options.timeoutMs ?? DEFAULT_CF_COMMAND_TIMEOUT_MS,
    "timeoutMs",
  );
  const deadlineAt = context.deadlineAt ?? Date.now() + retryBudgetMs;
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0) {
    throw new CfDebuggerError(
      "UNSAFE_INPUT",
      "deadlineAt must be a positive safe integer timestamp.",
    );
  }
  return {
    env: options.env,
    redactionValues: normalizeSensitiveValues([
      ...(context.sensitiveValues ?? []),
      ...(options.sensitiveValues ?? []),
    ]),
    attemptTimeoutMs,
    deadlineAt,
  };
}

async function executeCfAttempt(
  args: readonly string[],
  context: CfExecContext,
  options: ResolvedCfRunOptions,
  timeoutMs: number,
): Promise<string> {
  const result = await executeFileBounded(resolveBin(context), args, {
    env: {
      ...buildEnv(context.cfHome),
      ...options.env,
      CF_COLOR: "false",
      CF_HOME: context.cfHome,
    },
    maxBuffer: MAX_BUFFER,
    timeoutMs,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  return result.stdout;
}

function signalCfChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // The command already exited.
  }
}

export async function executeFileBounded(
  command: string,
  args: readonly string[],
  options: BoundedExecFileOptions,
): Promise<{ readonly stderr: string; readonly stdout: string }> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const child = execFile(command, [...args], {
      env: options.env,
      maxBuffer: options.maxBuffer ?? MAX_BUFFER,
      encoding: "utf8",
    }, (error: ExecFileException | null, stdout: string, stderr: string) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error === null && options.signal?.aborted !== true) {
        resolve({ stderr, stdout });
        return;
      }
      const failure = error ?? new Error("Command was aborted.");
      Reflect.set(failure, "stderr", stderr);
      reject(failure);
    });
    const terminateAndReject = (code: "ABORT_ERR" | "ETIMEDOUT", message: string): void => {
      if (settled) {
        return;
      }
      signalCfChild(child, "SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      const failure = new Error(message);
      Reflect.set(failure, "code", code);
      Reflect.set(failure, "killed", true);
      Reflect.set(failure, "stderr", "");
      rejectOnce(failure);
    };
    const onAbort = (): void => {
      terminateAndReject("ABORT_ERR", "Command was aborted.");
    };
    const timer = setTimeout(() => {
      terminateAndReject("ETIMEDOUT", "Command exceeded its execution deadline.");
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }
  });
}

function retryDelayMs(attempt: number): number {
  return Math.min(1000 * (2 ** Math.min(attempt - 1, 10)), MAX_RETRY_DELAY_MS);
}

function createCfCliError(
  args: readonly string[],
  failure: CfFailureDetails,
  redactionValues: readonly string[],
): CfDebuggerError {
  const stderr = redactSensitiveText(failure.stderr?.trim() ?? "", redactionValues);
  const fallback = redactSensitiveText(failure.message, redactionValues);
  const detail = stderr.length > 0 ? stderr : fallback;
  return new CfDebuggerError(
    "CF_CLI_FAILED",
    `cf ${formatArgsForError(args, redactionValues)} failed: ${detail}`,
    stderr,
  );
}

function timeoutError(
  context: CfExecContext,
  args: readonly string[],
  redactionValues: readonly string[],
): CfDebuggerError {
  if (context.deadlineAt !== undefined) {
    const timeoutMs = context.startupTimeoutMs;
    const duration = timeoutMs === undefined ? "configured" : `${(timeoutMs / 1000).toString()}s`;
    return new CfDebuggerError(
      "STARTUP_TIMEOUT",
      `Debugger startup could not complete within its ${duration} deadline during ` +
        `${context.phase ?? "a CF command"}.`,
    );
  }
  return new CfDebuggerError(
    "CF_CLI_TIMEOUT",
    `cf ${formatArgsForError(args, redactionValues)} exceeded its overall retry budget.`,
  );
}

function reportRetry(
  context: CfExecContext,
  args: readonly string[],
  attempt: number,
  delayMs: number,
  remainingMs: number,
  redactionValues: readonly string[],
): void {
  context.onRetry?.({
    attempt,
    command: `cf ${formatArgsForError(args, redactionValues)}`,
    delayMs,
    remainingMs,
  });
}

export async function runCf(
  args: readonly string[],
  context: CfExecContext,
  input: number | CfRunOptions = {},
): Promise<string> {
  if (context.signal?.aborted) {
    throw abortError(context);
  }
  const options = resolveRunOptions(context, input);
  let attempt = 0;

  for (;;) {
    const remainingMs = options.deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw timeoutError(context, args, options.redactionValues);
    }
    attempt += 1;
    const attemptTimeoutMs = Math.max(1, Math.min(options.attemptTimeoutMs, remainingMs));
    const startedAt = Date.now();
    try {
      return await executeCfAttempt(args, context, options, attemptTimeoutMs);
    } catch (error: unknown) {
      const failure = readFailureDetails(error);
      if (context.signal?.aborted || failure.code === "ABORT_ERR") {
        throw abortError(context);
      }
      const elapsedMs = Date.now() - startedAt;
      const attemptTimedOut = failure.killed &&
        elapsedMs + 100 >= attemptTimeoutMs;
      if (
        isCredentialRejection(args, failure) ||
        !isTransientNetworkError(failure, attemptTimedOut)
      ) {
        throw createCfCliError(args, failure, options.redactionValues);
      }
      const delayMs = retryDelayMs(attempt);
      const afterFailureMs = options.deadlineAt - Date.now();
      if (afterFailureMs <= delayMs) {
        throw timeoutError(context, args, options.redactionValues);
      }
      reportRetry(
        context,
        args,
        attempt,
        delayMs,
        afterFailureMs,
        options.redactionValues,
      );
      await waitForRetry(delayMs, context);
    }
  }
}
