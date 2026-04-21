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

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (err) => {
      rejectPromise(err);
    });
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

export interface StartFakeGraphOptions {
  readonly scenario: unknown;
}

export async function startFakeGraph(options: StartFakeGraphOptions): Promise<FakeGraphProcess> {
  const child: ChildProcess = spawn("node", [FAKE_GRAPH_PATH], {
    env: {
      ...process.env,
      SHAREPOINT_FAKE_SCENARIO: JSON.stringify(options.scenario),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[fake-graph] ${chunk.toString("utf8")}`);
  });

  const port = await new Promise<number>((resolvePort, rejectPort) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const match = /LISTENING (\d+)\n/.exec(buffer);
      if (match) {
        child.stdout?.off("data", onData);
        const raw = match[1];
        if (raw === undefined) {
          rejectPort(new Error("Fake graph emitted LISTENING without port"));
          return;
        }
        resolvePort(Number.parseInt(raw, 10));
      }
    };
    child.stdout?.on("data", onData);
    child.on("error", rejectPort);
    child.on("exit", (code) => {
      if (code !== 0) {
        rejectPort(new Error(`Fake graph exited early with code ${String(code)}`));
      }
    });
  });

  async function stop(): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.kill("SIGTERM");
    await once(child, "close").catch(() => {
      /* ignore */
    });
  }

  return { port, stop };
}

export function buildBaseEnv(port: number): Record<string, string> {
  return {
    SHAREPOINT_AUTH_BASE: `http://127.0.0.1:${port.toString()}`,
    SHAREPOINT_GRAPH_BASE: `http://127.0.0.1:${port.toString()}/v1.0`,
  };
}
