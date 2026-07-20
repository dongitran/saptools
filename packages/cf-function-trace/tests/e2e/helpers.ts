import { spawn, type ChildProcess } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const E2E_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIRECTORY = join(E2E_DIRECTORY, "fixtures");
const PACKAGE_ROOT = resolve(E2E_DIRECTORY, "../..");
export const CLI_PATH = join(PACKAGE_ROOT, "dist", "cli.js");
export const PASSWORD_SENTINEL = "E2E_PASSWORD_SENTINEL_7a93";
export const BEARER_SENTINEL = "E2E_BEARER_SENTINEL_b481";

const WAIT_TIMEOUT_MS = 15_000;

export interface E2eWorkspace {
  readonly root: string;
  readonly home: string;
  readonly appRoot: string;
  readonly appFile: string;
  readonly appFileUrl: string;
  readonly dataRoot: string;
}

export interface FixtureProcess {
  readonly child: ChildProcess;
  readonly inspectorPort: number;
  readonly httpPort: number;
  readonly fileUrl: string;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

export interface CliResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunningCli {
  readonly child: ChildProcess;
  readonly armed: Promise<void>;
  readonly completed: Promise<CliResult>;
}

export interface StoredFile {
  readonly path: string;
  readonly content: string;
}

export interface FakeCfFixture {
  readonly binPath: string;
  readonly logPath: string;
}

interface FixtureReady {
  readonly httpPort: number;
  readonly fileUrl: string;
}

function processEnvironment(home: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: home,
    USERPROFILE: home,
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    PATH: process.env["PATH"] ?? "",
    ...overrides,
  };
}

function withTimeout<TResult>(promise: Promise<TResult>, label: string): Promise<TResult> {
  return new Promise<TResult>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      rejectPromise(new Error(`${label} timed out after ${WAIT_TIMEOUT_MS.toString()}ms`));
    }, WAIT_TIMEOUT_MS);
    promise.then((value) => {
      clearTimeout(timeout);
      resolvePromise(value);
    }, (error: unknown) => {
      clearTimeout(timeout);
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function observeLines(stream: Readable, onLine: (line: string) => void): () => string {
  let output = "";
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    output += chunk;
    pending += chunk;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      onLine(line);
    }
  });
  stream.on("end", () => {
    if (pending.length > 0) {
      onLine(pending);
      pending = "";
    }
  });
  return () => output;
}

function requirePipe(stream: Readable | null, label: string): Readable {
  if (stream === null) {
    throw new Error(`${label} pipe is unavailable`);
  }
  return stream;
}

function waitForExit(child: ChildProcess): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      resolvePromise({ code, signal });
    });
  });
}

async function materializeApp(workspace: E2eWorkspace): Promise<void> {
  const packageDirectory = join(workspace.appRoot, "node_modules", "e2e-external");
  await mkdir(packageDirectory, { recursive: true });
  await copyFile(join(FIXTURES_DIRECTORY, "inspectable-app.mjs.txt"), workspace.appFile);
  await copyFile(join(FIXTURES_DIRECTORY, "app-child.mjs.txt"), join(workspace.appRoot, "app-child.mjs"));
  await copyFile(join(FIXTURES_DIRECTORY, "app-grandchild.mjs.txt"), join(workspace.appRoot, "app-grandchild.mjs"));
  await copyFile(join(FIXTURES_DIRECTORY, "external-package.mjs.txt"), join(packageDirectory, "index.mjs"));
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify({
    name: "e2e-external",
    type: "module",
    exports: "./index.mjs",
  }), "utf8");
}

export async function createE2eWorkspace(): Promise<E2eWorkspace> {
  const createdRoot = await mkdtemp(join(tmpdir(), "cf-function-trace-e2e-"));
  const root = await realpath(createdRoot);
  const home = join(root, "home");
  const appRoot = join(root, "app");
  const appFile = join(appRoot, "inspectable-app.mjs");
  const workspace: E2eWorkspace = {
    root,
    home,
    appRoot,
    appFile,
    appFileUrl: pathToFileURL(appFile).href,
    dataRoot: join(home, ".saptools", "cf-function-trace", "data"),
  };
  await mkdir(home, { recursive: true });
  await materializeApp(workspace);
  return workspace;
}

export async function materializeFakeCf(workspace: E2eWorkspace): Promise<FakeCfFixture> {
  const binPath = join(workspace.root, "fake-cf.mjs");
  const logPath = join(workspace.root, "fake-cf.log");
  await copyFile(join(FIXTURES_DIRECTORY, "fake-cf.mjs.txt"), binPath);
  await chmod(binPath, 0o700);
  return { binPath, logPath };
}

function parseFixtureReady(line: string): FixtureReady | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    const event = Reflect.get(value, "event");
    const httpPort = Reflect.get(value, "httpPort");
    const fileUrl = Reflect.get(value, "fileUrl");
    return event === "fixture-ready" && typeof httpPort === "number" && typeof fileUrl === "string"
      ? { httpPort, fileUrl }
      : undefined;
  } catch {
    return undefined;
  }
}

function inspectorPort(line: string): number | undefined {
  const match = /Debugger listening on ws:\/\/[^:]+:(\d+)\//u.exec(line);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const port = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(port) && port > 0 ? port : undefined;
}

export async function startFixture(workspace: E2eWorkspace): Promise<FixtureProcess> {
  const child = spawn(process.execPath, ["--inspect=0", workspace.appFile], {
    cwd: workspace.appRoot,
    env: processEnvironment(workspace.home),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let resolveReady: (value: FixtureReady) => void = () => undefined;
  let resolveInspector: (value: number) => void = () => undefined;
  const readyPromise = new Promise<FixtureReady>((resolvePromise) => {
    resolveReady = resolvePromise;
  });
  const inspectorPromise = new Promise<number>((resolvePromise) => {
    resolveInspector = resolvePromise;
  });
  const stdout = observeLines(requirePipe(child.stdout, "fixture stdout"), (line) => {
    const ready = parseFixtureReady(line);
    if (ready !== undefined) {
      resolveReady(ready);
    }
  });
  const stderr = observeLines(requirePipe(child.stderr, "fixture stderr"), (line) => {
    const port = inspectorPort(line);
    if (port !== undefined) {
      resolveInspector(port);
    }
  });
  const earlyExit = waitForExit(child).then(({ code, signal }) => {
    throw new Error(`fixture exited before ready: code=${String(code)} signal=${String(signal)} stderr=${stderr()}`);
  });
  const [ready, port] = await Promise.all([
    withTimeout(Promise.race([readyPromise, earlyExit]), "fixture ready signal"),
    withTimeout(Promise.race([inspectorPromise, earlyExit]), "inspector listening signal"),
  ]);
  return {
    child,
    inspectorPort: port,
    httpPort: ready.httpPort,
    fileUrl: ready.fileUrl,
    stdout,
    stderr,
  };
}

function isArmedLine(line: string): boolean {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null
      && Reflect.get(value, "event") === "breakpoint-armed";
  } catch {
    return false;
  }
}

export function startCli(
  workspace: E2eWorkspace,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): RunningCli {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd: PACKAGE_ROOT,
    env: processEnvironment(workspace.home, env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let armed = false;
  let resolveArmed: () => void = () => undefined;
  let rejectArmed: (error: Error) => void = () => undefined;
  const armedSignal = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveArmed = resolvePromise;
    rejectArmed = rejectPromise;
  });
  const stdout = observeLines(requirePipe(child.stdout, "CLI stdout"), () => undefined);
  const stderr = observeLines(requirePipe(child.stderr, "CLI stderr"), (line) => {
    if (!armed && isArmedLine(line)) {
      armed = true;
      resolveArmed();
    }
  });
  const completed = withTimeout(waitForExit(child), "CLI completion").then(({ code, signal }) => {
    if (!armed) {
      rejectArmed(new Error(`CLI exited before breakpoint armed: ${stderr()}`));
    }
    return { code, signal, stdout: stdout(), stderr: stderr() };
  });
  return {
    child,
    armed: withTimeout(armedSignal, "breakpoint armed signal"),
    completed,
  };
}

export async function runCli(
  workspace: E2eWorkspace,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  const running = startCli(workspace, args, env);
  void running.armed.catch(() => undefined);
  return await running.completed;
}

export async function triggerRequest(fixture: FixtureProcess): Promise<string> {
  const response = await triggerFixtureRequest(fixture, "/run", 200);
  return await response.text();
}

export async function triggerThrowingRequest(fixture: FixtureProcess): Promise<string> {
  const response = await triggerFixtureRequest(fixture, "/throw", 500);
  return await response.text();
}

async function triggerFixtureRequest(
  fixture: FixtureProcess,
  path: string,
  expectedStatus: number,
): Promise<Response> {
  const response = await fetch(`http://127.0.0.1:${fixture.httpPort.toString()}${path}?value=4`, {
    method: "POST",
    signal: AbortSignal.timeout(WAIT_TIMEOUT_MS),
  });
  if (response.status !== expectedStatus) {
    const body = await response.text();
    throw new Error(`fixture request returned ${response.status.toString()}: ${body}`);
  }
  return response;
}

export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  try {
    await withTimeout(waitForExit(child), "process shutdown");
  } catch {
    child.kill("SIGKILL");
    await withTimeout(waitForExit(child), "forced process shutdown");
  }
}

async function collectFiles(directory: string, relativeDirectory: string): Promise<readonly StoredFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: StoredFile[] = [];
  for (const entry of entries) {
    const relativePath = join(relativeDirectory, entry.name);
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolutePath, relativePath));
    } else if (entry.isFile()) {
      files.push({ path: relativePath, content: await readFile(absolutePath, "utf8") });
    }
  }
  return files;
}

export async function readStoredFiles(workspace: E2eWorkspace): Promise<readonly StoredFile[]> {
  return await collectFiles(workspace.dataRoot, "");
}

export async function cleanupWorkspace(workspace: E2eWorkspace): Promise<void> {
  await rm(workspace.root, { recursive: true, force: true });
}

export function parseJsonObject(text: string, label: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(text);
  if (!isJsonObject(parsed)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return parsed;
}

export function objectArray(value: unknown, label: string): readonly Readonly<Record<string, unknown>>[] {
  if (!isJsonObjectArray(value)) {
    throw new Error(`${label} is not an object array`);
  }
  return value;
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObjectArray(
  value: unknown,
): value is readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(value) && value.every(isJsonObject);
}
