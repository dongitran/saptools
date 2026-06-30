import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import type { CompactTraceEvent } from "../../src/trace-compact.js";
import type { StoredTraceEvent } from "../../src/trace-store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..");
const CLI_PATH = resolve(PACKAGE_ROOT, "dist", "cli.js");
const FAKE_CF_BIN = resolve(HERE, "fixtures", "fake-cf.mjs");
const APP_FIXTURE_PATH = resolve(HERE, "fixtures", "inspectable-app.mjs");

type SpawnedChild = ChildProcessByStdio<null, Readable, Readable>;

interface InspectableApp {
  readonly child: SpawnedChild;
  readonly httpPort: number;
  readonly inspectorPort: number;
  close(): Promise<void>;
}

interface TraceCli {
  waitForStreaming(): Promise<void>;
  waitForExit(): Promise<CliResult>;
  close(): Promise<void>;
}

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

test("User can capture HTTP request and response events through a fake CF tunnel", async () => {
  ensureCliBuilt();
  const paths = await prepareCase("captures-http-event");
  const app = await spawnInspectableApp();
  const cli = startTraceCli(paths, app.inspectorPort);

  try {
    await cli.waitForStreaming();
    const response = await postTraceRequest(app.httpPort);
    expect(response).toContain('"ok":true');

    const result = await cli.waitForExit();
    expect(result.code, result.stderr).toBe(0);
    const events = parseTraceEvents(result.stdout);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({
      sessionId: expect.stringMatching(/^s[0-9a-f]{16}$/),
      requestId: expect.stringMatching(/^r[0-9a-f]{16}$/),
      instance: "0",
      method: "POST",
      normalizedUrl: "/orders/42?expand=items",
      status: 201,
      correlationId: "e2e-trace-1",
      requestBodyFormat: "json",
      responseBodyFormat: "json",
      requestBodyPreview: '{"sku":"A-100","quantity":2}',
    }));
    expect(events[0]?.responseBodyPreview).toContain('"ok":true');
    expect(events[0]).not.toHaveProperty("appId");
    expect(events[0]).not.toHaveProperty("requestHeaders");
    expect(events[0]).not.toHaveProperty("responseHeaders");
    const stored = await readSingleBackupEvent(paths.root, events[0]?.sessionId ?? "");
    expect(stored.event.appId).toBe("orders-api");
    expect(stored.event.responseHeaders["x-fixture"]).toBe("cf-live-trace");
    expect(stored.requestBodyFormat).toBe("json");
    expect(await readFakeCfCommands(paths.logPath)).toEqual([
      "api",
      "auth",
      "target",
      "ssh-enabled",
      "ssh",
      "ssh",
    ]);
  } finally {
    await cli.close();
    await app.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

function ensureCliBuilt(): void {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`cf-live-trace CLI not built at ${CLI_PATH}. Run pnpm build first.`);
  }
}

async function prepareCase(name: string): Promise<{ readonly root: string; readonly cfHome: string; readonly logPath: string }> {
  const root = join(tmpdir(), "cf-live-trace-e2e", name);
  const cfHome = join(root, "cf-home");
  const logPath = join(root, "fake-cf.jsonl");
  await rm(root, { recursive: true, force: true });
  await mkdir(cfHome, { recursive: true });
  return { root, cfHome, logPath };
}

async function spawnInspectableApp(): Promise<InspectableApp> {
  const child = spawn(process.execPath, ["--inspect=127.0.0.1:0", APP_FIXTURE_PATH], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ports = await withTimeout(waitForAppPorts(child), 15_000, "Inspectable app did not start.");
  await waitForInspector(ports.inspectorPort, 10_000);
  return {
    child,
    httpPort: ports.httpPort,
    inspectorPort: ports.inspectorPort,
    close: async (): Promise<void> => {
      await closeProcess(child);
    },
  };
}

function waitForAppPorts(child: SpawnedChild): Promise<{ readonly httpPort: number; readonly inspectorPort: number }> {
  return new Promise((resolvePorts, rejectPorts) => {
    let stdout = "";
    let stderr = "";
    let httpPort: number | undefined;
    let inspectorPort: number | undefined;
    const tryResolve = (): void => {
      if (httpPort !== undefined && inspectorPort !== undefined) {
        resolvePorts({ httpPort, inspectorPort });
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      httpPort = parsePort(stdout, /HTTP_READY (\d+)/);
      tryResolve();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      inspectorPort = parsePort(stderr, /Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)/);
      tryResolve();
    });
    child.once("error", rejectPorts);
    child.once("exit", () => {
      rejectPorts(new Error(`Inspectable app exited early. stdout: ${stdout} stderr: ${stderr}`));
    });
  });
}

function parsePort(text: string, pattern: RegExp): number | undefined {
  const raw = pattern.exec(text)?.[1];
  return raw === undefined ? undefined : Number.parseInt(raw, 10);
}

async function waitForInspector(port: number, timeoutMs: number): Promise<void> {
  await waitForCondition(async () => await isInspectorReady(port), timeoutMs, `Inspector ${port.toString()} was not ready.`);
}

async function isInspectorReady(port: number): Promise<boolean> {
  try {
    const body = await requestText(port, "/json/list", "GET");
    const parsed = JSON.parse(body) as unknown;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

function startTraceCli(
  paths: { readonly root: string; readonly cfHome: string; readonly logPath: string },
  inspectorPort: number,
): TraceCli {
  const env = createCliEnv(paths, inspectorPort);
  const args = buildCliArgs(paths.cfHome);
  const child = spawn(process.execPath, [CLI_PATH, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  const buffers = { stdout: "", stderr: "" };
  const streaming = waitForStreaming(child, buffers);
  const exit = waitForCliExit(child, buffers);
  return {
    waitForStreaming: async (): Promise<void> => {
      await withTimeout(streaming, 30_000, buffers.stderr);
    },
    waitForExit: async (): Promise<CliResult> => await withTimeout(exit, 30_000, buffers.stderr),
    close: async (): Promise<void> => {
      await closeProcess(child);
    },
  };
}

function createCliEnv(
  paths: { readonly root: string; readonly logPath: string },
  inspectorPort: number,
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["FORCE_COLOR"];
  delete env["NO_COLOR"];
  return {
    ...env,
    HOME: paths.root,
    USERPROFILE: paths.root,
    CF_LIVE_TRACE_FAKE_LOG_PATH: paths.logPath,
    CF_LIVE_TRACE_TEST_INSPECTOR_PORT: inspectorPort.toString(),
  };
}

function buildCliArgs(cfHome: string): readonly string[] {
  return [
    "--api-endpoint",
    "https://api.example.com",
    "--org",
    "sample-org",
    "--space",
    "dev",
    "--app",
    "orders-api",
    "--email",
    "sample@example.com",
    "--password",
    "sample-password",
    "--cf-home",
    cfHome,
    "--cf-command",
    FAKE_CF_BIN,
    "--max-events",
    "1",
    "--format",
    "ndjson",
  ];
}

function waitForStreaming(child: SpawnedChild, buffers: { stdout: string; stderr: string }): Promise<void> {
  return new Promise((resolveStreaming, rejectStreaming) => {
    let streaming = false;
    child.stdout.on("data", (chunk: Buffer) => {
      buffers.stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      buffers.stderr += chunk.toString("utf8");
      if (!streaming && buffers.stderr.includes("[cf-live-trace] streaming:")) {
        streaming = true;
        resolveStreaming();
      }
    });
    child.once("error", rejectStreaming);
    child.once("exit", () => {
      if (!streaming) {
        rejectStreaming(new Error(`CLI exited before streaming. stderr: ${buffers.stderr}`));
      }
    });
  });
}

function waitForCliExit(child: SpawnedChild, buffers: { stdout: string; stderr: string }): Promise<CliResult> {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code) => {
      resolveExit({ code, stdout: buffers.stdout, stderr: buffers.stderr });
    });
  });
}

async function postTraceRequest(port: number): Promise<string> {
  const body = '{"sku":"A-100","quantity":2}';
  return await requestText(port, "/orders/42?expand=items", "POST", {
    body,
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body).toString(),
      "x-saptools-trace-id": "e2e-trace-1",
    },
  });
}

function requestText(
  port: number,
  path: string,
  method: "GET" | "POST",
  options: { readonly body?: string; readonly headers?: Record<string, string> } = {},
): Promise<string> {
  return new Promise((resolveText, rejectText) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolveText(Buffer.concat(chunks).toString("utf8"));
      });
    });
    req.once("error", rejectText);
    req.end(options.body);
  });
}

async function readFakeCfCommands(path: string): Promise<readonly string[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.trim().split("\n").filter((line) => line.length > 0).map((line) => {
      const parsed = JSON.parse(line) as { readonly command: string };
      return parsed.command;
    });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

function parseTraceEvents(raw: string): readonly CompactTraceEvent[] {
  return raw.trim().split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as CompactTraceEvent);
}

async function readSingleBackupEvent(root: string, sessionId: string): Promise<StoredTraceEvent> {
  const eventsDir = join(root, ".saptools", "cf-live-trace", "sessions", sessionId, "events");
  const files = (await readdir(eventsDir)).filter((file) => file.endsWith(".json"));
  expect(files).toHaveLength(1);
  return JSON.parse(await readFile(join(eventsDir, files[0] ?? ""), "utf8")) as StoredTraceEvent;
}

async function waitForCondition(check: () => Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await delay(100);
  }
  throw new Error(message);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function closeProcess(child: SpawnedChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolveClosed) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveClosed();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveClosed();
    });
    child.kill("SIGTERM");
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
