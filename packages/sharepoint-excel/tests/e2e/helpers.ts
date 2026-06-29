import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(HERE, "..", "..");
export const CLI_PATH = resolve(PACKAGE_ROOT, "dist", "cli.js");
export const FAKE_GRAPH_PATH = resolve(HERE, "fixtures", "fake-graph.mjs");

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

export async function runCli(options: RunOptions): Promise<RunResult> {
  return await new Promise<RunResult>((resolvePromise, rejectPromise) => {
    const child = spawn("node", [CLI_PATH, ...options.args], {
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

export interface FakeGraphProcess {
  readonly port: number;
  stop: () => Promise<void>;
}

export async function startFakeGraph(scenario: unknown): Promise<FakeGraphProcess> {
  const child: ChildProcess = spawn("node", [FAKE_GRAPH_PATH], {
    env: { ...process.env, SHAREPOINT_EXCEL_FAKE_SCENARIO: JSON.stringify(scenario) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[fake-graph] ${chunk.toString("utf8")}`);
  });
  const port = await waitForPort(child);
  return {
    port,
    async stop(): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill("SIGTERM");
      await once(child, "close").catch(() => {
        /* ignore */
      });
    },
  };
}

async function waitForPort(child: ChildProcess): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const match = /LISTENING (\d+)\n/.exec(buffer);
      const rawPort = match?.[1];
      if (rawPort === undefined) {
        return;
      }
      child.stdout?.off("data", onData);
      resolvePort(Number.parseInt(rawPort, 10));
    };
    child.stdout?.on("data", onData);
    child.on("error", rejectPort);
    child.on("exit", (code) => {
      if (code !== 0) {
        rejectPort(new Error(`Fake graph exited early with code ${String(code)}`));
      }
    });
  });
}

export function buildBaseEnv(port: number): Record<string, string> {
  return {
    SHAREPOINT_EXCEL_AUTH_BASE: `http://127.0.0.1:${port.toString()}`,
    SHAREPOINT_EXCEL_GRAPH_BASE: `http://127.0.0.1:${port.toString()}/v1.0`,
  };
}
