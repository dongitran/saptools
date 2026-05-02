import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { CfDebuggerError } from "../types.js";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;
const CF_CLI_TIMEOUT_MS = 30_000;
const REDACTED_ARG = "<redacted>";

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

export async function runCf(
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
