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

function formatArgsForError(args: readonly string[]): string {
  if (args[0] !== "auth") {
    return args.join(" ");
  }
  return args.map((arg, index) => (index === 0 ? arg : REDACTED_ARG)).join(" ");
}

function isTransientNetworkError(err: NodeJS.ErrnoException & { stderr?: string; stdout?: string; killed?: boolean }): boolean {
  if (err.killed && !err.code) {
    // Likely killed due to timeout
    return true;
  }
  
  const code = err.code ?? "";
  const networkCodes = ["ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"];
  if (networkCodes.includes(code)) {
    return true;
  }
  
  const output = `${err.message} ${err.stderr ?? ""} ${err.stdout ?? ""}`.toLowerCase();
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

export async function runCf(
  args: readonly string[],
  context: CfExecContext,
  timeoutMs: number = DEFAULT_CF_COMMAND_TIMEOUT_MS,
): Promise<string> {
  let attempt = 0;
  
  for (;;) {
    try {
      const { stdout } = await execFileAsync(resolveBin(context), [...args], {
        env: buildEnv(context.cfHome),
        maxBuffer: MAX_BUFFER,
        timeout: timeoutMs,
      });
      return stdout;
    } catch (err: unknown) {
      attempt++;
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string; killed?: boolean };
      const isTransient = isTransientNetworkError(e);
      if (isTransient && attempt <= MAX_RETRIES) {
        const delayMs = Math.min(1000 * (2 ** (attempt - 1)), 10000); // 1s, 2s, 4s... max 10s
        await new Promise((resolve) => { setTimeout(resolve, delayMs); });
        continue;
      }

      const redactionValues = sensitiveArgs(args);
      const stderr = redactText(e.stderr?.trim() ?? "", redactionValues);
      const fallbackMessage = redactText(e.message, redactionValues);
      throw new CfDebuggerError(
        "CF_CLI_FAILED",
        `cf ${formatArgsForError(args)} failed: ${stderr.length > 0 ? stderr : fallbackMessage}`,
        stderr,
      );
    }
  }
}
