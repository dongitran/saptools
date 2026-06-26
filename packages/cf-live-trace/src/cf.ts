import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { connect as netConnect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { CfLiveTraceTarget, PortForwardHandle, TunnelOpenResult } from "./types.js";

const execFileAsync = promisify(execFile);

const CF_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const CF_COMMAND_TIMEOUT_MS = 180_000;
const CF_SSH_READY_TIMEOUT_MS = 60_000;
const INSPECTOR_SIGNAL_TIMEOUT_MS = 15_000;
const INSPECTOR_REMOTE_HOST = "127.0.0.1";
const INSPECTOR_REMOTE_PORT = 9229;
const TUNNEL_KEEPALIVE_SECONDS = 6 * 60 * 60;
const TUNNEL_READY_TIMEOUT_MS = 20_000;
const TUNNEL_READY_POLL_MS = 200;

export interface RunCfOptions {
  readonly cfHomeDir?: string;
  readonly command?: string;
  readonly envOverrides?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly redactor?: (message: string) => string;
}

export interface CfDependencies {
  runCf(args: readonly string[], options: RunCfOptions): Promise<string>;
}

export interface TunnelDependencies {
  allocatePort(): Promise<number>;
  spawnPortForward(params: PortForwardParams): PortForwardHandle;
  waitForLocalPort(port: number, timeoutMs: number): Promise<boolean>;
}

export interface PortForwardParams {
  readonly appName: string;
  readonly localPort: number;
  readonly remoteHost: string;
  readonly remotePort: number;
  readonly keepAliveSeconds: number;
  readonly cfHomeDir?: string;
  readonly command?: string;
  readonly instanceIndex?: number;
}

export interface InspectorTunnelTarget {
  readonly app?: string;
  readonly appName?: string;
  readonly cfHomeDir?: string;
  readonly command?: string;
  readonly instanceIndex?: number;
}

export async function createTemporaryCfHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "saptools-cf-live-trace-"));
}

export async function removeTemporaryCfHome(cfHomeDir: string): Promise<void> {
  await rm(cfHomeDir, { recursive: true, force: true });
}

export async function prepareCfSession(
  target: CfLiveTraceTarget,
  dependencies: CfDependencies = defaultCfDependencies,
): Promise<void> {
  const apiEndpoint = resolveApiEndpoint(target);
  const redactor = createSecretRedactor([target.email, target.password]);
  const baseOptions = buildRunOptions(target, redactor);
  await dependencies.runCf(["api", apiEndpoint], baseOptions);
  await dependencies.runCf(["auth"], {
    ...baseOptions,
    envOverrides: { CF_USERNAME: target.email, CF_PASSWORD: target.password },
  });
  await dependencies.runCf(["target", "-o", target.org, "-s", target.space], baseOptions);
}

export async function ensureSshEnabled(
  target: Pick<CfLiveTraceTarget, "app" | "cfHomeDir" | "command" | "email" | "password" | "instanceIndex">,
  dependencies: CfDependencies = defaultCfDependencies,
): Promise<void> {
  const redactor = createSecretRedactor([target.email, target.password]);
  const options = buildRunOptions(target, redactor);
  const status = await dependencies.runCf(["ssh-enabled", target.app], options);
  if (parseSshStatus(status) === "enabled") {
    return;
  }
  await dependencies.runCf(["enable-ssh", target.app], options);
  await dependencies.runCf(["restart", target.app], options);
  await dependencies.runCf(buildCfSshArgs(target.app, target.instanceIndex, ["-c", "true"]), {
    ...options,
    timeoutMs: CF_SSH_READY_TIMEOUT_MS,
  });
}

export async function tryStartNodeInspector(
  target: Pick<CfLiveTraceTarget, "app" | "cfHomeDir" | "command" | "email" | "password" | "instanceIndex">,
  dependencies: CfDependencies = defaultCfDependencies,
): Promise<boolean> {
  try {
    const redactor = createSecretRedactor([target.email, target.password]);
    const stdout = await dependencies.runCf(
      buildCfSshArgs(target.app, target.instanceIndex, ["-c", buildInspectorSignalCommand()]),
      { ...buildRunOptions(target, redactor), timeoutMs: INSPECTOR_SIGNAL_TIMEOUT_MS },
    );
    return hasInspectorReadyMarker(stdout);
  } catch {
    return false;
  }
}

export async function openInspectorTunnel(
  target: InspectorTunnelTarget,
  dependencies: TunnelDependencies = defaultTunnelDependencies,
): Promise<TunnelOpenResult> {
  const localPort = await dependencies.allocatePort();
  const handle = dependencies.spawnPortForward(buildPortForwardParams(target, localPort));
  const ready = await raceForwardReadiness(handle, dependencies);
  if (!ready) {
    handle.stop();
    return { status: "not-reachable" };
  }
  return { status: "ready", handle };
}

export function buildCfSshArgs(appName: string, instanceIndex: number | undefined, tail: readonly string[]): string[] {
  const args = ["ssh", appName];
  if (instanceIndex !== undefined) {
    args.push("-i", String(instanceIndex));
  }
  return [...args, ...tail];
}

export function buildInspectorSignalCommand(): string {
  return INSPECTOR_SIGNAL_COMMAND;
}

export function createSecretRedactor(secrets: readonly string[]): (message: string) => string {
  const values = secrets.map((secret) => secret.trim()).filter((secret) => secret.length > 0);
  return (message: string): string => values.reduce((current, secret) => current.split(secret).join("<redacted>"), message);
}

export async function runCfCommand(args: readonly string[], options: RunCfOptions): Promise<string> {
  const command = resolveCommand(options.command);
  try {
    const { stdout } = await execFileAsync(command.bin, [...command.argsPrefix, ...args], {
      env: buildCfEnv(options.cfHomeDir, options.envOverrides),
      maxBuffer: CF_MAX_BUFFER_BYTES,
      timeout: options.timeoutMs ?? CF_COMMAND_TIMEOUT_MS,
    });
    return stdout;
  } catch (error) {
    throw new Error(formatCfError(args, error, options.redactor), { cause: error });
  }
}

export function spawnPortForward(params: PortForwardParams): PortForwardHandle {
  const command = resolveCommand(params.command);
  const forwardSpec = `${String(params.localPort)}:${params.remoteHost}:${String(params.remotePort)}`;
  const sshArgs = buildCfSshArgs(params.appName, params.instanceIndex, ["-L", forwardSpec, "-c", `sleep ${String(params.keepAliveSeconds)}`]);
  const child = spawn(command.bin, [...command.argsPrefix, ...sshArgs], {
    env: buildCfEnv(params.cfHomeDir),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    process: child,
    localPort: params.localPort,
    stop(): void {
      if (!child.killed) {
        child.kill();
      }
    },
  };
}

export const defaultCfDependencies: CfDependencies = {
  runCf: runCfCommand,
};

export const defaultTunnelDependencies: TunnelDependencies = {
  allocatePort: findFreePort,
  spawnPortForward,
  waitForLocalPort,
};

function buildRunOptions(target: Pick<CfLiveTraceTarget, "cfHomeDir" | "command">, redactor: (message: string) => string): RunCfOptions {
  return {
    ...(target.cfHomeDir === undefined ? {} : { cfHomeDir: target.cfHomeDir }),
    ...(target.command === undefined ? {} : { command: target.command }),
    redactor,
  };
}

function resolveApiEndpoint(target: Pick<CfLiveTraceTarget, "apiEndpoint" | "region">): string {
  if (target.apiEndpoint !== undefined && target.apiEndpoint.trim().length > 0) {
    return target.apiEndpoint.trim();
  }
  if (target.region === undefined) {
    throw new Error("CF region or apiEndpoint is required.");
  }
  const endpoint = REGION_API_ENDPOINTS[target.region];
  if (endpoint === undefined) {
    throw new Error(`Unknown CF region: ${target.region}`);
  }
  return endpoint;
}

const REGION_API_ENDPOINTS: Readonly<Record<string, string>> = {
  ae01: "https://api.cf.ae01.hana.ondemand.com",
  ap01: "https://api.cf.ap01.hana.ondemand.com",
  ap10: "https://api.cf.ap10.hana.ondemand.com",
  ap11: "https://api.cf.ap11.hana.ondemand.com",
  ap12: "https://api.cf.ap12.hana.ondemand.com",
  ap20: "https://api.cf.ap20.hana.ondemand.com",
  ap21: "https://api.cf.ap21.hana.ondemand.com",
  ap30: "https://api.cf.ap30.hana.ondemand.com",
  br10: "https://api.cf.br10.hana.ondemand.com",
  br20: "https://api.cf.br20.hana.ondemand.com",
  br30: "https://api.cf.br30.hana.ondemand.com",
  ca10: "https://api.cf.ca10.hana.ondemand.com",
  ca20: "https://api.cf.ca20.hana.ondemand.com",
  ch20: "https://api.cf.ch20.hana.ondemand.com",
  eu10: "https://api.cf.eu10.hana.ondemand.com",
  eu11: "https://api.cf.eu11.hana.ondemand.com",
  eu12: "https://api.cf.eu12.hana.ondemand.com",
  eu20: "https://api.cf.eu20.hana.ondemand.com",
  eu21: "https://api.cf.eu21.hana.ondemand.com",
  eu30: "https://api.cf.eu30.hana.ondemand.com",
  eu31: "https://api.cf.eu31.hana.ondemand.com",
  in30: "https://api.cf.in30.hana.ondemand.com",
  jp10: "https://api.cf.jp10.hana.ondemand.com",
  jp20: "https://api.cf.jp20.hana.ondemand.com",
  jp30: "https://api.cf.jp30.hana.ondemand.com",
  kr30: "https://api.cf.kr30.hana.ondemand.com",
  us10: "https://api.cf.us10.hana.ondemand.com",
  us11: "https://api.cf.us11.hana.ondemand.com",
  us20: "https://api.cf.us20.hana.ondemand.com",
  us21: "https://api.cf.us21.hana.ondemand.com",
  us30: "https://api.cf.us30.hana.ondemand.com",
  us31: "https://api.cf.us31.hana.ondemand.com",
};

function regionKeyForApiEndpoint(apiEndpoint: string): string | undefined {
  const normalized = normalizeApiEndpoint(apiEndpoint);
  for (const [key, endpoint] of Object.entries(REGION_API_ENDPOINTS)) {
    if (normalizeApiEndpoint(endpoint) === normalized) {
      return key;
    }
  }
  return undefined;
}

function normalizeApiEndpoint(apiEndpoint: string): string {
  return apiEndpoint.trim().replace(/\/+$/, "").toLowerCase();
}

function parseSshStatus(stdout: string): "enabled" | "disabled" {
  return stdout.toLowerCase().includes("enabled") && !stdout.toLowerCase().includes("disabled") ? "enabled" : "disabled";
}

function buildPortForwardParams(
  target: InspectorTunnelTarget,
  localPort: number,
): PortForwardParams {
  return {
    appName: resolveTunnelAppName(target),
    localPort,
    remoteHost: INSPECTOR_REMOTE_HOST,
    remotePort: INSPECTOR_REMOTE_PORT,
    keepAliveSeconds: TUNNEL_KEEPALIVE_SECONDS,
    ...(target.cfHomeDir === undefined ? {} : { cfHomeDir: target.cfHomeDir }),
    ...(target.command === undefined ? {} : { command: target.command }),
    ...(target.instanceIndex === undefined ? {} : { instanceIndex: target.instanceIndex }),
  };
}

function resolveTunnelAppName(target: InspectorTunnelTarget): string {
  const appName = target.appName ?? target.app;
  if (appName === undefined || appName.trim().length === 0) {
    throw new Error("CF app name is required for the inspector tunnel.");
  }
  return appName;
}

async function raceForwardReadiness(handle: PortForwardHandle, dependencies: TunnelDependencies): Promise<boolean> {
  let markFailed: () => void = () => {
    return;
  };
  const failedEarly = new Promise<false>((resolve) => {
    markFailed = (): void => {
      resolve(false);
    };
    handle.process.once("exit", markFailed);
    handle.process.once("error", markFailed);
  });
  const ready = dependencies.waitForLocalPort(handle.localPort, TUNNEL_READY_TIMEOUT_MS);
  const outcome = await Promise.race([ready, failedEarly]);
  handle.process.removeListener("exit", markFailed);
  handle.process.removeListener("error", markFailed);
  return outcome;
}

function resolveCommand(command?: string): { readonly bin: string; readonly argsPrefix: readonly string[] } {
  const resolvedBin = command ?? process.env["CF_LIVE_TRACE_CF_BIN"] ?? "cf";
  return /\.(?:c|m)?js$/i.test(resolvedBin)
    ? { bin: process.execPath, argsPrefix: [resolvedBin] }
    : { bin: resolvedBin, argsPrefix: [] };
}

function buildCfEnv(cfHomeDir?: string, envOverrides?: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["SAP_EMAIL"];
  delete env["SAP_PASSWORD"];
  if (cfHomeDir !== undefined && cfHomeDir.length > 0) {
    env["CF_HOME"] = cfHomeDir;
  }
  return envOverrides === undefined ? env : { ...env, ...envOverrides };
}

function formatCfError(args: readonly string[], error: unknown, redactor?: (message: string) => string): string {
  const detail = extractErrorDetail(error);
  const message = `cf ${formatArgs(args)} failed${detail.length > 0 ? `: ${detail}` : "."}`;
  return redactor?.(message) ?? message;
}

function extractErrorDetail(error: unknown): string {
  if (!isRecord(error)) {
    return "";
  }
  const stderr = typeof error["stderr"] === "string" ? error["stderr"].trim() : "";
  if (stderr.length > 0) {
    return stderr;
  }
  return error["message"] instanceof Error ? error["message"].message : "";
}

function formatArgs(args: readonly string[]): string {
  return args.join(" ");
}

function hasInspectorReadyMarker(stdout: string): boolean {
  return stdout.split(/\r?\n/).map((line) => line.trim()).includes("saptools-inspector-ready");
}

function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        if (port === 0) {
          reject(new Error("Failed to allocate a local port."));
          return;
        }
        resolve(port);
      });
    });
  });
}

function waitForLocalPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<boolean>((resolve) => {
    const attempt = (): void => {
      const socket = netConnect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        retryPortProbe(socket, deadline, attempt, resolve);
      });
    };
    attempt();
  });
}

function retryPortProbe(socket: ReturnType<typeof netConnect>, deadline: number, attempt: () => void, resolve: (ready: boolean) => void): void {
  socket.destroy();
  if (Date.now() >= deadline) {
    resolve(false);
    return;
  }
  setTimeout(attempt, TUNNEL_READY_POLL_MS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface CurrentCfTarget {
  readonly apiEndpoint: string;
  readonly regionKey?: string;
  readonly orgName: string;
  readonly spaceName: string;
}

export interface CurrentCfTargetReadOptions {
  readonly command?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

const CURRENT_TARGET_TIMEOUT_MS = 30_000;

export async function readCurrentCfTarget(
  options?: CurrentCfTargetReadOptions,
): Promise<CurrentCfTarget | undefined> {
  const opts = options ?? {};
  const command = resolveCommand(opts.command);
  const env = buildCfEnvForTarget(opts.env);
  try {
    const { stdout } = await execFileAsync(command.bin, [...command.argsPrefix, "target"], {
      env,
      maxBuffer: CF_MAX_BUFFER_BYTES,
      timeout: opts.timeoutMs ?? CURRENT_TARGET_TIMEOUT_MS,
    });
    return parseCurrentCfTarget(stdout);
  } catch {
    return undefined;
  }
}

export function parseCurrentCfTarget(stdout: string): CurrentCfTarget | undefined {
  const fields = parseTargetFields(stdout);
  const apiEndpoint = fields.get("api endpoint");
  const org = fields.get("org");
  const space = fields.get("space");
  if (!apiEndpoint || !org || !space) {
    return undefined;
  }
  const regionKey = regionKeyForApiEndpoint(apiEndpoint);
  return {
    apiEndpoint,
    ...(regionKey === undefined ? {} : { regionKey }),
    orgName: org,
    spaceName: space,
  };
}

function parseTargetFields(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) {
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key.length > 0 && val.length > 0) {
      map.set(key, val);
    }
  }
  return map;
}

function buildCfEnvForTarget(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  delete env["SAP_EMAIL"];
  delete env["SAP_PASSWORD"];
  return env;
}

const INSPECTOR_SIGNAL_COMMAND = [
  'inspector_url="http://127.0.0.1:9229/json/list"',
  'inspector_ready() { ((command -v curl >/dev/null 2>&1 && curl -fsS --max-time 1 "$inspector_url" >/dev/null 2>&1) || (command -v wget >/dev/null 2>&1 && wget -qO- -T 1 "$inspector_url" >/dev/null 2>&1)); }',
  "if inspector_ready; then",
  "echo saptools-inspector-ready",
  "exit 0",
  "fi",
  'node_pid=""',
  "best_score=-1",
  "for pid_dir in /proc/[0-9]*; do",
  '[ -d "$pid_dir" ] || continue',
  'node_exe="$(readlink "$pid_dir/exe" 2>/dev/null || true)"',
  '[ "${node_exe##*/}" = "node" ] || continue',
  'node_cmdline="$(tr "\\000" " " < "$pid_dir/cmdline" 2>/dev/null || true)"',
  '[ -n "$node_cmdline" ] || continue',
  "score=10",
  'if printf "%s\\n" "$node_cmdline" | grep -Eq "@sap/cds|cds/bin/serve|serve\\.js|server\\.js|app\\.js|dist|build|index\\.js"; then',
  "score=20",
  "fi",
  'if [ "$score" -gt "$best_score" ]; then',
  'best_score="$score"',
  'node_pid="${pid_dir##*/}"',
  "fi",
  "done",
  'if [ -z "$node_pid" ]; then',
  "echo saptools-inspector-node-not-found",
  "exit 0",
  "fi",
  'echo "saptools-inspector-node-pid=$node_pid"',
  'if kill -USR1 "$node_pid" 2>/dev/null; then',
  "echo saptools-inspector-signaled",
  "else",
  "echo saptools-inspector-signal-failed",
  "exit 0",
  "fi",
  "attempt=0",
  'while [ "$attempt" -lt 20 ]; do',
  "if inspector_ready; then",
  "echo saptools-inspector-ready",
  "exit 0",
  "fi",
  "attempt=$((attempt + 1))",
  "sleep 0.25",
  "done",
  "echo saptools-inspector-not-ready",
].join("\\n");
