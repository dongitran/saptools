import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { CLI_PATH } from "./helpers.js";

export const SAPTOOLS_DIR_NAME = ".saptools";
export const CF_DEBUGGER_STATE_FILENAME = "cf-debugger-state-v2.json";

export interface StartedSession {
  readonly child: ChildProcess;
  readonly localPort: number;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

export interface RunningCli {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

export function spawnCli(env: NodeJS.ProcessEnv, args: readonly string[]): RunningCli {
  const child = spawn("node", [CLI_PATH, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));
  return {
    child,
    stdout: () => stdoutChunks.join(""),
    stderr: () => stderrChunks.join(""),
  };
}

export interface CliCommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runCliCommand(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<CliCommandResult> {
  const running = spawnCli(env, args);
  const result = await waitForCliExit(running.child);
  return {
    code: result.code,
    stdout: running.stdout(),
    stderr: running.stderr(),
  };
}

export async function startCli(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  readyTimeoutMs: number,
): Promise<StartedSession> {
  const running = spawnCli(env, args);
  const { child } = running;

  const readyOutput = await new Promise<string>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      rejectPromise(
        new Error(
          `cf-debugger did not become ready in time.\nstdout: ${running.stdout()}\nstderr: ${running.stderr()}`,
        ),
      );
    }, readyTimeoutMs);
    const check = (): void => {
      const joined = running.stdout();
      if (joined.includes("Debugger ready for ")) {
        clearTimeout(timeout);
        resolvePromise(joined);
      }
    };
    child.stdout.on("data", check);
    child.once("exit", () => {
      clearTimeout(timeout);
      rejectPromise(
        new Error(
          `cf-debugger exited before ready.\nstdout: ${running.stdout()}\nstderr: ${running.stderr()}`,
        ),
      );
    });
  });

  const portMatch = /Local port:\s+(\d+)/.exec(readyOutput);
  const localPort = Number.parseInt(portMatch?.[1] ?? "0", 10);

  return {
    child,
    localPort,
    stdout: running.stdout,
    stderr: running.stderr,
  };
}

export async function stopCli(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolvePromise) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
    }, 15_000);
    child.once("close", () => {
      clearTimeout(t);
      resolvePromise();
    });
  });
}

export async function waitForCliExit(child: ChildProcess): Promise<{ readonly code: number | null }> {
  if (child.exitCode !== null) {
    return { code: child.exitCode };
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    child.once("close", (code) => {
      resolvePromise({ code });
    });
    child.once("error", rejectPromise);
  });
}

export async function readStateFile(homeDir: string): Promise<string> {
  const path = join(homeDir, SAPTOOLS_DIR_NAME, CF_DEBUGGER_STATE_FILENAME);
  if (!existsSync(path)) {
    return "";
  }
  return await readFile(path, "utf8");
}

export async function readState(homeDir: string): Promise<unknown> {
  const raw = await readStateFile(homeDir);
  if (raw === "") {
    return undefined;
  }
  return JSON.parse(raw) as unknown;
}
