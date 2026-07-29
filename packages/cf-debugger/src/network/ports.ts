import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { get as httpGet, type IncomingMessage } from "node:http";
import { createServer, Socket } from "node:net";
import { promisify } from "node:util";

import { CfDebuggerError } from "../types.js";

const execFileAsync = promisify(execFile);
const PROBE_INTERVAL_MS = 250;
const INITIAL_INSPECTOR_ATTEMPT_TIMEOUT_MS = 2_500;
const MAX_INSPECTOR_ATTEMPT_TIMEOUT_MS = 10_000;
const MAX_INSPECTOR_RESPONSE_BYTES = 64 * 1_024;
const OWNER_COMMAND_TIMEOUT_MS = 5_000;

interface PidCommandResult {
  readonly available: boolean;
  readonly pids: readonly number[];
  readonly reason?: string;
}

interface ProcSocketResult extends PidCommandResult {
  readonly listenerFound: boolean;
}

export type ListeningProcessInspection =
  | { readonly status: "found"; readonly pids: readonly number[] }
  | { readonly status: "not-listening"; readonly pids: readonly number[] }
  | { readonly status: "unverified"; readonly reason: string };

export type PortOwnershipInspection =
  | { readonly status: "owned"; readonly pids: readonly number[] }
  | { readonly status: "not-owned"; readonly pids: readonly number[] }
  | { readonly status: "not-listening"; readonly pids: readonly number[] }
  | { readonly status: "unverified"; readonly reason: string };

export type InspectorReadinessResult =
  | { readonly status: "ready" }
  | { readonly status: "unreachable" };

function sortedUniquePids(pids: Iterable<number>): readonly number[] {
  return [...new Set(pids)].sort((left, right) => left - right);
}

function parseAddressPort(address: string): number | undefined {
  const separator = address.lastIndexOf(":");
  const portText = separator >= 0 ? address.slice(separator + 1) : "";
  if (!/^\d+$/.test(portText)) {
    return undefined;
  }
  return Number.parseInt(portText, 10);
}

export function parseWindowsNetstatListeningPids(
  output: string,
  port: number,
): readonly number[] {
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const protocol = fields[0]?.toUpperCase();
    const localAddress = fields[1];
    const state = fields[3]?.toUpperCase();
    const pidText = fields[4];
    if (
      protocol !== "TCP"
      || localAddress === undefined
      || state !== "LISTENING"
      || pidText === undefined
      || parseAddressPort(localAddress) !== port
    ) {
      continue;
    }
    const pid = Number.parseInt(pidText, 10);
    if (Number.isSafeInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return sortedUniquePids(pids);
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

function errorStderr(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stderr" in error)) {
    return "";
  }
  return typeof error.stderr === "string" ? error.stderr.trim() : "";
}

async function findListeningPidsWithNetstat(
  port: number,
  signal?: AbortSignal,
): Promise<PidCommandResult> {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano"], {
      ...(signal === undefined ? {} : { signal }),
      timeout: OWNER_COMMAND_TIMEOUT_MS,
    });
    return {
      available: true,
      pids: parseWindowsNetstatListeningPids(stdout, port),
    };
  } catch (error: unknown) {
    throwIfAborted(signal);
    return {
      available: false,
      pids: [],
      reason: `Unable to inspect listening ports with netstat (${String(errorCode(error) ?? "unknown error")}).`,
    };
  }
}

async function findListeningPidsWithLsof(
  port: number,
  signal?: AbortSignal,
): Promise<PidCommandResult> {
  try {
    const { stdout } = await execFileAsync("lsof", [
      "-nP",
      "-t",
      "-i",
      `tcp:${port.toString()}`,
      "-sTCP:LISTEN",
    ], {
      ...(signal === undefined ? {} : { signal }),
      timeout: OWNER_COMMAND_TIMEOUT_MS,
    });
    const pids = stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => Number.parseInt(line, 10))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    return { available: true, pids: sortedUniquePids(pids) };
  } catch (error: unknown) {
    throwIfAborted(signal);
    if (errorCode(error) === 1 && errorStderr(error).length === 0) {
      return { available: true, pids: [] };
    }
    const missing = errorCode(error) === "ENOENT";
    return {
      available: false,
      pids: [],
      reason: missing
        ? "The lsof command is required to verify tunnel ownership on this platform."
        : `lsof could not inspect the listening port (${String(errorCode(error) ?? "unknown error")}).`,
    };
  }
}

async function collectListeningSocketInodes(
  path: string,
  port: number,
  inodes: Set<string>,
): Promise<boolean> {
  try {
    const content = await readFile(path, "utf8");
    for (const line of content.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      const localAddress = fields[1];
      const state = fields[3];
      const inode = fields[9];
      if (localAddress === undefined || state === undefined || inode === undefined) {
        continue;
      }
      const localPort = Number.parseInt(localAddress.split(":")[1] ?? "", 16);
      if (localPort === port && state === "0A") {
        inodes.add(inode);
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function findListeningSocketInodesWithProc(
  port: number,
): Promise<{ readonly available: boolean; readonly inodes: ReadonlySet<string> }> {
  const inodes = new Set<string>();
  const tcpAvailable = await collectListeningSocketInodes("/proc/net/tcp", port, inodes);
  const tcp6Available = await collectListeningSocketInodes("/proc/net/tcp6", port, inodes);
  return { available: tcpAvailable || tcp6Available, inodes };
}

async function processHasSocketInode(pid: string, inodes: ReadonlySet<string>): Promise<boolean> {
  try {
    const descriptors = await readdir(`/proc/${pid}/fd`);
    for (const descriptor of descriptors) {
      try {
        const link = await readlink(`/proc/${pid}/fd/${descriptor}`);
        const match = /^socket:\[(\d+)\]$/.exec(link);
        if (match?.[1] !== undefined && inodes.has(match[1])) {
          return true;
        }
      } catch {
        // The process may close descriptors while we scan them.
      }
    }
  } catch {
    // The process may exit, or permissions may prevent fd inspection.
  }
  return false;
}

async function findListeningPidsWithProc(
  port: number,
  signal?: AbortSignal,
): Promise<ProcSocketResult> {
  throwIfAborted(signal);
  const socketResult = await findListeningSocketInodesWithProc(port);
  if (!socketResult.available) {
    return {
      available: false,
      listenerFound: false,
      pids: [],
      reason: "The /proc socket tables are unavailable.",
    };
  }
  if (socketResult.inodes.size === 0) {
    return { available: true, listenerFound: false, pids: [] };
  }
  try {
    const entries = await readdir("/proc", { withFileTypes: true });
    const pids = new Set<number>();
    for (const entry of entries) {
      throwIfAborted(signal);
      if (
        entry.isDirectory()
        && /^\d+$/.test(entry.name)
        && await processHasSocketInode(entry.name, socketResult.inodes)
      ) {
        pids.add(Number.parseInt(entry.name, 10));
      }
    }
    return {
      available: true,
      listenerFound: true,
      pids: sortedUniquePids(pids),
    };
  } catch {
    throwIfAborted(signal);
    return {
      available: false,
      listenerFound: true,
      pids: [],
      reason: "A listener exists, but its owner could not be inspected through /proc.",
    };
  }
}

function inspectionFromPids(pids: readonly number[]): ListeningProcessInspection {
  return pids.length > 0
    ? { status: "found", pids }
    : { status: "not-listening", pids };
}

export async function inspectListeningProcesses(
  port: number,
  signal?: AbortSignal,
): Promise<ListeningProcessInspection> {
  throwIfAborted(signal);
  if (process.platform === "win32") {
    const netstat = await findListeningPidsWithNetstat(port, signal);
    return netstat.available
      ? inspectionFromPids(netstat.pids)
      : { status: "unverified", reason: netstat.reason ?? "netstat is unavailable." };
  }

  const lsof = await findListeningPidsWithLsof(port, signal);
  if (lsof.pids.length > 0) {
    return { status: "found", pids: lsof.pids };
  }
  if (process.platform === "darwin") {
    return lsof.available
      ? { status: "not-listening", pids: [] }
      : { status: "unverified", reason: lsof.reason ?? "lsof is unavailable." };
  }

  const proc = await findListeningPidsWithProc(port, signal);
  if (proc.pids.length > 0) {
    return { status: "found", pids: proc.pids };
  }
  if (proc.listenerFound || (!proc.available && !lsof.available)) {
    return {
      status: "unverified",
      reason: proc.reason ?? lsof.reason ?? "The listener owner could not be verified.",
    };
  }
  return { status: "not-listening", pids: [] };
}

export function classifyPortOwnership(
  pids: readonly number[],
  expectedPid: number,
): PortOwnershipInspection {
  return pids.includes(expectedPid)
    ? { status: "owned", pids }
    : { status: "not-owned", pids };
}

export async function inspectPortOwnership(
  port: number,
  expectedPid: number,
  signal?: AbortSignal,
): Promise<PortOwnershipInspection> {
  const inspection = await inspectListeningProcesses(port, signal);
  if (inspection.status === "unverified") {
    return inspection;
  }
  if (inspection.status === "not-listening") {
    return inspection;
  }
  return classifyPortOwnership(inspection.pids, expectedPid);
}

export async function isPortFree(
  port: number,
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfAborted(signal);
  return await new Promise<boolean>((resolve, reject) => {
    const server = createServer();
    let settled = false;
    const finish = (available: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(available);
    };
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (server.listening) {
        server.close();
      }
      signal?.removeEventListener("abort", onAbort);
      reject(new CfDebuggerError("ABORTED", "Operation aborted by caller"));
    };
    server.once("error", () => {
      finish(false);
    });
    server.once("listening", () => {
      server.close(() => {
        finish(true);
      });
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    server.listen(port, "127.0.0.1");
  });
}

export async function isPortListening(port: number, timeoutMs = 200): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (listening: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.once("connect", () => {
      finish(true);
    });
    socket.once("error", () => {
      finish(false);
    });
    socket.once("timeout", () => {
      finish(false);
    });
    socket.setTimeout(positiveTimeout(timeoutMs));
    socket.connect({ port, host: "127.0.0.1" });
  });
}

function positiveTimeout(timeoutMs: number): number {
  return Number.isFinite(timeoutMs)
    ? Math.max(1, Math.floor(timeoutMs))
    : 1;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CfDebuggerError("ABORTED", "Operation aborted by caller");
  }
}

function waitForNextProbe(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CfDebuggerError("ABORTED", "Operation aborted by caller"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
}

export async function probeTunnelReady(
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  throwIfAborted(signal);

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (await isPortListening(port, positiveTimeout(Math.min(200, remainingMs)))) {
      return true;
    }
    const waitMs = Math.min(PROBE_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (waitMs > 0) {
      await waitForNextProbe(waitMs, signal);
    }
  }

  throwIfAborted(signal);
  return false;
}

function parseJson(body: string): unknown {
  return JSON.parse(body) as unknown;
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function hasAttachableInspectorTarget(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = parseJson(body);
  } catch {
    return false;
  }
  if (!isUnknownArray(parsed) || parsed.length === 0) {
    return false;
  }
  const first = parsed[0];
  if (!isUnknownRecord(first)) {
    return false;
  }
  const candidate = first["webSocketDebuggerUrl"];
  if (typeof candidate !== "string") {
    return false;
  }
  try {
    const url = new URL(candidate);
    return (url.protocol === "ws:" || url.protocol === "wss:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function readInspectorResponse(
  response: IncomingMessage,
  finish: (ready: boolean) => void,
): void {
  if (response.statusCode !== 200) {
    response.destroy();
    finish(false);
    return;
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  response.on("data", (chunk: Buffer) => {
    totalBytes += chunk.length;
    if (totalBytes > MAX_INSPECTOR_RESPONSE_BYTES) {
      response.destroy();
      finish(false);
      return;
    }
    chunks.push(chunk);
  });
  response.once("end", () => {
    finish(hasAttachableInspectorTarget(Buffer.concat(chunks).toString("utf8")));
  });
  response.once("error", () => {
    finish(false);
  });
}

interface InspectorAttemptState {
  settled: boolean;
  removeAbortListener?: () => void;
  timer?: NodeJS.Timeout;
}

function finishInspectorAttempt(
  state: InspectorAttemptState,
  ready: boolean,
  resolve: (ready: boolean) => void,
): void {
  if (state.settled) {
    return;
  }
  state.settled = true;
  clearTimeout(state.timer);
  state.removeAbortListener?.();
  resolve(ready);
}

function probeInspectorAttempt(
  port: number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  throwIfAborted(signal);
  return new Promise<boolean>((resolve, reject) => {
    const state: InspectorAttemptState = { settled: false };
    const finish = (ready: boolean): void => {
      finishInspectorAttempt(state, ready, resolve);
    };
    const request = httpGet(
      { agent: false, host: "127.0.0.1", port, path: "/json/list" },
      (response) => {
        readInspectorResponse(response, finish);
      },
    );
    const onAbort = (): void => {
      request.destroy();
      if (!state.settled) {
        state.settled = true;
        clearTimeout(state.timer);
        state.removeAbortListener?.();
        reject(new CfDebuggerError("ABORTED", "Operation aborted by caller"));
      }
    };
    state.removeAbortListener = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    state.timer = setTimeout(() => {
      request.destroy();
      finish(false);
    }, positiveTimeout(timeoutMs));
    request.once("error", () => {
      if (signal?.aborted) {
        onAbort();
        return;
      }
      finish(false);
    });
  });
}

function inspectorAttemptTimeout(
  attempt: number,
  remainingMs: number,
): number {
  const growingCap = Math.min(
    MAX_INSPECTOR_ATTEMPT_TIMEOUT_MS,
    INITIAL_INSPECTOR_ATTEMPT_TIMEOUT_MS * (2 ** attempt),
  );
  // Keep half of the remaining budget available for a later attempt.
  const retryShare = Math.ceil(remainingMs / 2);
  return positiveTimeout(Math.min(growingCap, retryShare, remainingMs));
}

export async function probeInspectorReady(
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<InspectorReadinessResult> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  throwIfAborted(signal);

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const attemptTimeoutMs = inspectorAttemptTimeout(attempt, remainingMs);
    if (await probeInspectorAttempt(port, attemptTimeoutMs, signal)) {
      return { status: "ready" };
    }
    attempt += 1;
    const waitMs = Math.min(PROBE_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (waitMs > 0) {
      await waitForNextProbe(waitMs, signal);
    }
  }

  throwIfAborted(signal);
  return { status: "unreachable" };
}
