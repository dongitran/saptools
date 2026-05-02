import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { CfDebuggerError } from "../types.js";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;
const CF_CLI_TIMEOUT_MS = 30_000;

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
    const stderr = e.stderr?.trim() ?? "";
    throw new CfDebuggerError(
      "CF_CLI_FAILED",
      `cf ${args.join(" ")} failed: ${stderr.length > 0 ? stderr : e.message}`,
      stderr,
    );
  }
}
