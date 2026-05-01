import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { normalizeTarget, resolveCredentials, resolveInstance, resolveProcessName } from "../cf/target.js";
import { CfExplorerError } from "../core/errors.js";
import { EXPLORER_ERROR_CODES } from "../core/types.js";
import type {
  AttachedExplorerSession,
  ExplorerErrorCode,
  ExplorerRuntimeOptions,
  ExplorerSessionRecord,
  FindResult,
  GrepResult,
  InspectCandidatesResult,
  LsResult,
  RootsResult,
  SessionListResult,
  SessionStatusResult,
  StartSessionOptions,
  StopSessionOptions,
  StopSessionResult,
  ViewResult,
} from "../core/types.js";

import { sendIpcRequest, type IpcCommand, type IpcResponse } from "./ipc.js";
import { explorerHome, sessionsLockPath } from "./paths.js";
import {
  cleanupSessionFiles,
  isPidAlive,
  listExplorerSessions as listStoredExplorerSessions,
  pathExists,
  readExplorerSession,
  registerExplorerSession,
  removeExplorerSession,
  updateExplorerSession,
} from "./storage.js";

const STARTUP_TIMEOUT_MS = 20_000;
const STARTUP_POLL_MS = 100;
const STOP_GRACE_MS = 5_000;
const STOP_POLL_MS = 50;

interface BrokerBootstrap {
  readonly sessionId: string;
  readonly homeDir: string;
  readonly target: StartSessionOptions["target"];
  readonly process: string;
  readonly instance: number;
  readonly cfBin?: string;
  readonly idleTimeoutMs?: number;
  readonly maxLifetimeMs?: number;
}

export async function startExplorerSession(
  options: StartSessionOptions,
): Promise<ExplorerSessionRecord> {
  if (options.allInstances === true) {
    throw new CfExplorerError("UNSAFE_INPUT", "Persistent sessions target one instance. Use --instance instead.");
  }
  const runtime = options.runtime ?? {};
  const homeDir = runtime.homeDir ?? explorerHome(runtime.env);
  const sessionId = options.sessionIdFactory?.() ?? randomUUID();
  const processName = resolveProcessName(options.process);
  const instance = resolveInstance(options.instance);
  const target = normalizeTarget(options.target);
  const bootstrap = buildBootstrap(options, sessionId, homeDir, processName, instance);
  await registerExplorerSession({
    sessionId,
    brokerPid: process.pid,
    target,
    process: processName,
    instance,
    homeDir,
  });
  let childPid: number | undefined;
  try {
    const child = spawn(process.execPath, [brokerEntryPath()], {
      detached: true,
      env: buildBrokerEnv(runtime, bootstrap),
      stdio: "ignore",
    });
    if (child.pid === undefined) {
      throw new CfExplorerError("BROKER_UNAVAILABLE", "Failed to start broker process.");
    }
    childPid = child.pid;
    child.unref();
    await updateBrokerPid(homeDir, sessionId, child.pid);
    return await waitForBrokerReady(homeDir, sessionId, runtime.timeoutMs);
  } catch (error: unknown) {
    await cleanupFailedStart(homeDir, sessionId, childPid);
    throw error;
  }
}

export async function listExplorerSessions(
  runtime: ExplorerRuntimeOptions = {},
): Promise<SessionListResult> {
  const homeDir = runtime.homeDir ?? explorerHome(runtime.env);
  return { sessions: await listStoredExplorerSessions(homeDir) };
}

export async function getExplorerSessionStatus(
  sessionId: string,
  runtime: ExplorerRuntimeOptions = {},
): Promise<SessionStatusResult> {
  const homeDir = runtime.homeDir ?? explorerHome(runtime.env);
  const session = await readExplorerSession(homeDir, sessionId);
  if (session === undefined) {
    throw new CfExplorerError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
  }
  return await toSessionStatus(session);
}

export async function stopExplorerSession(options: StopSessionOptions = {}): Promise<StopSessionResult> {
  const runtime = options.runtime ?? {};
  const homeDir = runtime.homeDir ?? explorerHome(runtime.env);
  validateStopOptions(options);
  const sessions = await listStoredExplorerSessions(homeDir);
  const selected = options.all === true
    ? sessions
    : sessions.filter((session) => session.sessionId === options.sessionId);
  await Promise.all(selected.map(async (session) => {
    await stopOneSession(homeDir, session);
  }));
  return { stopped: selected.length };
}

export async function attachExplorerSession(
  sessionId: string,
  runtime: ExplorerRuntimeOptions = {},
): Promise<AttachedExplorerSession> {
  const homeDir = runtime.homeDir ?? explorerHome(runtime.env);
  const session = await readExplorerSession(homeDir, sessionId);
  if (session === undefined) {
    throw new CfExplorerError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
  }
  assertSessionReady(session);
  return {
    session,
    roots: async (options = {}) => await requestSession<RootsResult>(homeDir, session, "roots", options),
    ls: async (options) => await requestSession<LsResult>(homeDir, session, "ls", options),
    find: async (options) => await requestSession<FindResult>(homeDir, session, "find", options),
    grep: async (options) => await requestSession<GrepResult>(homeDir, session, "grep", options),
    view: async (options) => await requestSession<ViewResult>(homeDir, session, "view", options),
    inspectCandidates: async (options) => await requestSession<InspectCandidatesResult>(homeDir, session, "inspect", options),
    stop: async () => {
      await stopOneSession(homeDir, session);
    },
  };
}

async function requestSession<T>(
  homeDir: string,
  session: ExplorerSessionRecord,
  command: IpcCommand,
  args: Record<string, unknown>,
): Promise<T> {
  const current = await readExplorerSession(homeDir, session.sessionId);
  if (current === undefined) {
    throw new CfExplorerError("SESSION_NOT_FOUND", `Session not found: ${session.sessionId}`);
  }
  assertSessionReady(current);
  const timeoutMs = readPositiveNumber(args, "timeoutMs");
  const response = await sendIpcRequest(current.socketPath, {
    requestId: randomUUID(),
    sessionId: current.sessionId,
    command,
    args,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return requireIpcResult(response) as T;
}

async function stopOneSession(homeDir: string, session: ExplorerSessionRecord): Promise<void> {
  const brokerAcceptedStop = await requestBrokerStop(session);
  const stoppedGracefully = brokerAcceptedStop
    ? await waitForGracefulBrokerStop(homeDir, session)
    : false;
  if (!stoppedGracefully) {
    terminateProcess(session.brokerPid);
  }
  await removeSessionStateAndFiles(homeDir, session.sessionId);
}

async function requestBrokerStop(session: ExplorerSessionRecord): Promise<boolean> {
  if (!await pathExists(session.socketPath)) {
    return false;
  }
  return await sendStopRequest(session)
    .then(() => true)
    .catch(() => false);
}

async function waitForGracefulBrokerStop(
  homeDir: string,
  session: ExplorerSessionRecord,
): Promise<boolean> {
  const deadline = Date.now() + STOP_GRACE_MS;
  for (;;) {
    const lockPresent = await pathExists(sessionsLockPath(homeDir));
    const socketPresent = await pathExists(session.socketPath);
    if (!lockPresent && (!isPidAlive(session.brokerPid) || !socketPresent)) {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await sleep(STOP_POLL_MS);
  }
}

async function removeSessionStateAndFiles(homeDir: string, sessionId: string): Promise<void> {
  const removed = await removeExplorerSession(homeDir, sessionId);
  if (removed !== undefined) {
    await cleanupSessionFiles(removed, homeDir);
  }
}

async function sendStopRequest(session: ExplorerSessionRecord): Promise<void> {
  await sendIpcRequest(session.socketPath, {
    requestId: randomUUID(),
    sessionId: session.sessionId,
    command: "stop",
    args: {},
    timeoutMs: 5_000,
  });
}

function requireIpcResult(response: IpcResponse): unknown {
  if (response.ok && response.result !== undefined) {
    return response.result;
  }
  const code = parseExplorerErrorCode(response.error?.code) ?? "IPC_FAILED";
  throw new CfExplorerError(
    code,
    response.error?.message ?? "Broker returned an empty response.",
  );
}

function parseExplorerErrorCode(value: string | undefined): ExplorerErrorCode | undefined {
  if (value === undefined) {
    return undefined;
  }
  return isExplorerErrorCode(value) ? value : undefined;
}

function isExplorerErrorCode(value: string): value is ExplorerErrorCode {
  return (EXPLORER_ERROR_CODES as readonly string[]).includes(value);
}

function validateStopOptions(options: StopSessionOptions): void {
  if (options.all === true && options.sessionId !== undefined) {
    throw new CfExplorerError("UNSAFE_INPUT", "Use either sessionId or all, not both.");
  }
  if (options.all !== true && options.sessionId === undefined) {
    throw new CfExplorerError("UNSAFE_INPUT", "Pass sessionId or all to stop sessions.");
  }
}

function assertSessionReady(session: ExplorerSessionRecord): void {
  if (session.status === "ready" || session.status === "busy") {
    return;
  }
  if (session.status === "stale" || session.status === "stopped") {
    throw new CfExplorerError("SESSION_STALE", `Session is ${session.status}. Start a new session.`);
  }
  throw new CfExplorerError("BROKER_UNAVAILABLE", `Session is ${session.status}.`);
}

async function toSessionStatus(session: ExplorerSessionRecord): Promise<SessionStatusResult> {
  return {
    sessionId: session.sessionId,
    target: session.target,
    process: session.process,
    instance: session.instance,
    brokerAlive: isPidAlive(session.brokerPid),
    sshAlive: isPidAlive(session.sshPid),
    socketAlive: await pathExists(session.socketPath),
    status: session.status,
    ...(session.message === undefined ? {} : { message: session.message }),
  };
}

async function waitForBrokerReady(
  homeDir: string,
  sessionId: string,
  timeoutMs = STARTUP_TIMEOUT_MS,
): Promise<ExplorerSessionRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const session = await readExplorerSession(homeDir, sessionId);
    if (session?.status === "ready") {
      return session;
    }
    if (session?.status === "error") {
      throw new CfExplorerError("BROKER_UNAVAILABLE", session.message ?? "Broker failed.");
    }
    if (Date.now() > deadline) {
      throw new CfExplorerError("BROKER_UNAVAILABLE", "Timed out waiting for broker startup.");
    }
    await sleep(STARTUP_POLL_MS);
  }
}

function buildBootstrap(
  options: StartSessionOptions,
  sessionId: string,
  homeDir: string,
  processName: string,
  instance: number,
): BrokerBootstrap {
  return {
    sessionId,
    homeDir,
    target: normalizeTarget(options.target),
    process: processName,
    instance,
    ...(options.runtime?.cfBin === undefined ? {} : { cfBin: options.runtime.cfBin }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.maxLifetimeMs === undefined ? {} : { maxLifetimeMs: options.maxLifetimeMs }),
  };
}

function buildBrokerEnv(
  runtime: ExplorerRuntimeOptions,
  bootstrap: BrokerBootstrap,
): NodeJS.ProcessEnv {
  const env = { ...process.env, ...runtime.env };
  if (runtime.credentials !== undefined) {
    const credentials = resolveCredentials(runtime);
    env["SAP_EMAIL"] = credentials.email;
    env["SAP_PASSWORD"] = credentials.password;
  }
  env["CF_EXPLORER_BROKER_BOOTSTRAP"] = JSON.stringify(bootstrap);
  return env;
}

function brokerEntryPath(): string {
  return fileURLToPath(new URL("./broker.js", import.meta.url));
}

async function updateBrokerPid(homeDir: string, sessionId: string, brokerPid: number): Promise<void> {
  await updateExplorerSession(homeDir, sessionId, { brokerPid });
}

async function cleanupFailedStart(
  homeDir: string,
  sessionId: string,
  childPid: number | undefined,
): Promise<void> {
  if (childPid !== undefined && isPidAlive(childPid)) {
    terminateProcess(childPid);
  }
  const removed = await removeExplorerSession(homeDir, sessionId);
  if (removed !== undefined) {
    await cleanupSessionFiles(removed, homeDir);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function terminateProcess(pid: number): void {
  if (pid === process.pid || !isPidAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      throw error;
    }
  }
}

function readPositiveNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    throw new CfExplorerError("UNSAFE_INPUT", `${key} must be a positive integer.`);
  }
  return value;
}
