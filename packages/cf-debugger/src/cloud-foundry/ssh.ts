import { spawn } from "node:child_process";

import { buildEnv, resolveBin, type CfExecContext } from "./execute.js";

const CF_SSH_SIGNAL_TIMEOUT_MS = 15_000;

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
