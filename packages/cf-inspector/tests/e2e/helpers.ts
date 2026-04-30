import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..");

export const FIXTURE_PATH = resolve(HERE, "fixtures", "sample-app.mjs");
export const CLI_PATH = resolve(PACKAGE_ROOT, "dist", "cli.js");

export function ensureCliBuilt(): void {
  if (!existsSync(CLI_PATH)) {
    throw new Error(
      `cf-inspector CLI not built at ${CLI_PATH}. Run \`pnpm --filter @saptools/cf-inspector build\` first.`,
    );
  }
}

export interface SpawnedFixture {
  readonly child: ChildProcess;
  readonly port: number;
  readonly close: () => Promise<void>;
}

export interface SpawnFixtureOptions {
  readonly env?: Readonly<Record<string, string>>;
}

interface InspectorList {
  webSocketDebuggerUrl: string;
}

async function tryDiscover(port: number): Promise<boolean> {
  return await new Promise((resolveOnce) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/json/list", method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            const list = JSON.parse(text) as readonly InspectorList[];
            resolveOnce(Array.isArray(list) && list.length > 0);
          } catch {
            resolveOnce(false);
          }
        });
        res.on("error", () => {
          resolveOnce(false);
        });
      },
    );
    req.setTimeout(500, () => {
      req.destroy();
      resolveOnce(false);
    });
    req.on("error", () => {
      resolveOnce(false);
    });
    req.end();
  });
}

async function waitForInspector(port: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await tryDiscover(port)) {
      return;
    }
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  throw new Error(`Inspector on 127.0.0.1:${port.toString()} did not become reachable`);
}

function parseDebuggerListening(stderr: string): number | undefined {
  const match = /Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(stderr);
  if (match?.[1] === undefined) {
    return undefined;
  }
  return Number.parseInt(match[1], 10);
}

export async function spawnFixture(options: SpawnFixtureOptions = {}): Promise<SpawnedFixture> {
  const child = spawn(process.execPath, ["--inspect=0", FIXTURE_PATH], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...options.env },
  });

  let stderrBuf = "";
  const port = await new Promise<number>((resolveOnce, rejectOnce) => {
    const onErr = (chunk: Buffer): void => {
      stderrBuf += chunk.toString("utf8");
      const detected = parseDebuggerListening(stderrBuf);
      if (detected !== undefined) {
        child.stderr.off("data", onErr);
        resolveOnce(detected);
      }
    };
    child.stderr.on("data", onErr);
    child.once("error", rejectOnce);
    child.once("exit", () => {
      rejectOnce(new Error(`Fixture exited before inspector was ready. stderr: ${stderrBuf}`));
    });
  });

  await waitForInspector(port, 10_000);

  const close = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolveOnce) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolveOnce();
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        finish();
      }, 2000);
      child.once("exit", finish);
      child.kill("SIGTERM");
    });
  };

  return { child, port, close };
}

export interface RunCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export async function runCli(args: readonly string[], timeoutMs = 30_000): Promise<RunCliResult> {
  return await new Promise<RunCliResult>((resolveOnce, rejectOnce) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      rejectOnce(new Error(`CLI timed out after ${timeoutMs.toString()}ms. stdout: ${stdout} stderr: ${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveOnce({ stdout, stderr, exitCode: code ?? 0 });
    });
    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      rejectOnce(err);
    });
  });
}
