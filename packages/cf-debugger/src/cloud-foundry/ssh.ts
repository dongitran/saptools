import { spawn } from "node:child_process";

import {
  buildEnv,
  DEFAULT_CF_COMMAND_TIMEOUT_MS,
  resolveBin,
  type CfExecContext,
} from "./execute.js";

export interface CfSshSignalResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly signal?: NodeJS.Signals;
  readonly timedOutAfterMs?: number;
}

export async function cfSshOneShot(
  appName: string,
  command: string,
  context: CfExecContext,
  timeoutMs: number = DEFAULT_CF_COMMAND_TIMEOUT_MS,
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
      resolve({ exitCode: null, stderr: stderrBuf, timedOutAfterMs: timeoutMs });
    }, timeoutMs);

    child.stderr.on("data", (data: Buffer | string) => {
      stderrBuf += data.toString();
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(
        signal === null
          ? { exitCode: code, stderr: stderrBuf }
          : { exitCode: code, stderr: stderrBuf, signal },
      );
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
