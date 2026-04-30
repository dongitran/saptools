import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { rm } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  prepareCfCliSession,
  spawnPersistentSshShell,
  type CfCommandContext,
} from "./cf.js";
import {
  buildFindScript,
  buildGrepScript,
  buildInspectCandidatesScript,
  buildRootsScript,
  buildViewScript,
} from "./commands.js";
import { CfExplorerError } from "./errors.js";
import { createIpcServer, errorResponse, type IpcHandlerResult, type IpcRequest, type IpcResponse } from "./ipc.js";
import {
  parseFindOutput,
  parseGrepOutput,
  parseInspectOutput,
  parseRootsOutput,
  parseViewOutput,
} from "./parsers.js";
import { wrapRemoteScript, parseProtocolFrame, requireSuccessfulFrame, type WrappedRemoteCommand } from "./protocol.js";
import { cleanupSessionFiles, readExplorerSession, removeExplorerSession, updateExplorerSession } from "./storage.js";
import { normalizeTarget } from "./target.js";
import type {
  ExplorerMeta,
  ExplorerRuntimeOptions,
  ExplorerSessionRecord,
  ExplorerTarget,
  FindResult,
  GrepResult,
  InspectCandidatesResult,
  RootsResult,
  ViewResult,
} from "./types.js";

interface BrokerBootstrap {
  readonly sessionId: string;
  readonly homeDir: string;
  readonly target: ExplorerTarget;
  readonly process: string;
  readonly instance: number;
  readonly cfBin?: string;
  readonly idleTimeoutMs?: number;
  readonly maxLifetimeMs?: number;
}

interface PersistentResult {
  readonly stdout: string;
  readonly durationMs: number;
  readonly truncated: boolean;
}

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_LIFETIME_MS = 60 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

let activeBroker: ExplorerBroker | undefined;

class PersistentShell {
  private buffer = "";
  private pending: {
    readonly wrapped: WrappedRemoteCommand;
    readonly startedAt: number;
    readonly maxBytes: number;
    readonly timeout: NodeJS.Timeout;
    readonly resolve: (value: PersistentResult) => void;
    readonly reject: (error: Error) => void;
  } | undefined;
  private queue = Promise.resolve();
  private exited = false;

  public constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onExit?: (reason: string) => void,
  ) {
    child.stdout.on("data", (chunk: Buffer | string) => {
      this.handleStdout(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.handleStderr(chunk.toString());
    });
    child.once("error", (error) => {
      this.markExited(`Persistent SSH shell failed: ${error.message}`);
    });
    child.once("close", () => {
      this.markExited("Persistent SSH shell exited.");
    });
  }

  public get isAlive(): boolean {
    return !this.exited;
  }

  public execute(script: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES): Promise<PersistentResult> {
    const next = this.queue.then(async () => await this.executeNow(script, timeoutMs, maxBytes));
    this.queue = next.then(ignoreQueueResult, ignoreQueueResult);
    return next;
  }

  public stop(): void {
    this.child.kill("SIGTERM");
  }

  private async executeNow(
    script: string,
    timeoutMs: number,
    maxBytes: number,
  ): Promise<PersistentResult> {
    if (this.exited) {
      throw new CfExplorerError("SESSION_STALE", "Persistent SSH shell has exited.");
    }
    if (this.pending !== undefined) {
      throw new CfExplorerError("SESSION_BUSY", "Persistent session is busy.");
    }
    this.buffer = "";
    const wrapped = wrapRemoteScript(script);
    return await new Promise<PersistentResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rejectPending(new CfExplorerError("SESSION_RECOVERY_FAILED", "Persistent command timed out."));
        this.child.kill("SIGTERM");
      }, timeoutMs);
      this.pending = { wrapped, startedAt: Date.now(), maxBytes, timeout, resolve, reject };
      this.child.stdin.write(`${wrapped.script}\n`);
    });
  }

  private handleStdout(chunk: string): void {
    const pending = this.pending;
    if (pending === undefined) {
      return;
    }
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > pending.maxBytes) {
      this.rejectPending(new CfExplorerError("OUTPUT_LIMIT_EXCEEDED", "Persistent command output limit exceeded."));
      this.child.kill("SIGTERM");
      return;
    }
    let frame: ReturnType<typeof parseProtocolFrame>;
    try {
      frame = parseProtocolFrame(this.buffer, pending.wrapped);
    } catch (error: unknown) {
      this.rejectPending(normalizeBrokerError(error));
      this.child.kill("SIGTERM");
      return;
    }
    if (frame === undefined) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending = undefined;
    try {
      pending.resolve({
        stdout: requireSuccessfulFrame(frame),
        durationMs: Date.now() - pending.startedAt,
        truncated: false,
      });
    } catch (error: unknown) {
      pending.reject(normalizeBrokerError(error));
    }
  }

  private handleStderr(chunk: string): void {
    if (chunk.toLowerCase().includes("closed")) {
      this.markExited("Persistent SSH shell closed.");
    }
  }

  private markExited(reason: string): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.rejectPending(new CfExplorerError("SESSION_STALE", reason));
    try {
      this.onExit?.(reason);
    } catch {
      // Listener errors must not crash the broker.
    }
  }

  private rejectPending(error: Error): void {
    const pending = this.pending;
    if (pending === undefined) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending = undefined;
    pending.reject(error);
  }
}

export async function runBrokerFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const bootstrap = parseBootstrap(env["CF_EXPLORER_BROKER_BOOTSTRAP"]);
  const broker = new ExplorerBroker(bootstrap);
  activeBroker = broker;
  await broker.start();
}

class ExplorerBroker {
  private shell: PersistentShell | undefined;
  private session: ExplorerSessionRecord | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private hardTimer: NodeJS.Timeout | undefined;
  private shutdownStarted = false;

  public constructor(private readonly bootstrap: BrokerBootstrap) {}

  public async start(): Promise<void> {
    try {
      this.session = await this.requireSession();
      const context = await this.prepareContext();
      const child = spawnPersistentSshShell(this.bootstrap.target, context, this.bootstrap.process, this.bootstrap.instance);
      this.shell = new PersistentShell(child, (reason) => {
        this.handleShellExit(reason);
      });
      await updateExplorerSession(this.bootstrap.homeDir, this.bootstrap.sessionId, {
        status: "busy",
        ...(child.pid === undefined ? {} : { sshPid: child.pid }),
      });
      await this.runHandshake();
      await rm(this.session.socketPath, { force: true });
      await createIpcServer(this.session.socketPath, async (request) => await this.handleIpcRequest(request));
      await updateExplorerSession(this.bootstrap.homeDir, this.bootstrap.sessionId, { status: "ready" });
      this.armTimers();
    } catch (error: unknown) {
      await this.failStartup(error);
      throw error;
    }
  }

  private async runHandshake(): Promise<void> {
    const shell = this.requireShell();
    try {
      const result = await shell.execute("printf 'CFX\\tHANDSHAKE\\tok\\n'");
      if (!result.stdout.includes("CFX\tHANDSHAKE\tok")) {
        throw new CfExplorerError(
          "SESSION_HANDSHAKE_FAILED",
          "Persistent shell handshake produced unexpected output.",
        );
      }
    } catch (error: unknown) {
      if (error instanceof CfExplorerError && error.code === "SESSION_HANDSHAKE_FAILED") {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CfExplorerError("SESSION_HANDSHAKE_FAILED", `Persistent shell handshake failed: ${message}`);
    }
  }

  private async handleIpcRequest(request: IpcRequest): Promise<IpcResponse | IpcHandlerResult> {
    const response = await this.handleRequest(request);
    if (request.sessionId === this.bootstrap.sessionId && request.command === "stop" && response.ok) {
      return {
        response,
        afterFlush: () => {
          void this.shutdown();
        },
      };
    }
    return response;
  }

  private async handleRequest(request: IpcRequest): Promise<IpcResponse> {
    const startedAt = Date.now();
    try {
      this.resetIdleTimer();
      const result = await this.dispatch(request);
      return { requestId: request.requestId, ok: true, durationMs: Date.now() - startedAt, result };
    } catch (error: unknown) {
      const explorerError = error instanceof CfExplorerError
        ? error
        : new CfExplorerError("BROKER_UNAVAILABLE", error instanceof Error ? error.message : String(error));
      return { ...errorResponse(request.requestId, explorerError), durationMs: Date.now() - startedAt };
    } finally {
      if (request.sessionId === this.bootstrap.sessionId) {
        await this.touchLastUsed();
      }
    }
  }

  private async dispatch(request: IpcRequest): Promise<unknown> {
    if (request.sessionId !== this.bootstrap.sessionId) {
      throw new CfExplorerError("SESSION_NOT_FOUND", "Request targeted a different session.");
    }
    if (request.command === "status") {
      return this.session;
    }
    if (request.command === "stop") {
      return { stopped: true };
    }
    await this.ensureSessionCanRunCommand();
    return await this.runExplorerCommand(request);
  }

  private async ensureSessionCanRunCommand(): Promise<void> {
    const session = await readExplorerSession(this.bootstrap.homeDir, this.bootstrap.sessionId);
    if (session === undefined) {
      throw new CfExplorerError("SESSION_STALE", "Persistent session state is no longer available.");
    }
    if (session.status === "stale" || session.status === "stopped") {
      throw new CfExplorerError("SESSION_STALE", `Persistent session is ${session.status}.`);
    }
    if (session.status === "error") {
      throw new CfExplorerError("BROKER_UNAVAILABLE", session.message ?? "Persistent session is in error state.");
    }
  }

  private async runExplorerCommand(request: IpcRequest): Promise<unknown> {
    const shell = this.requireShell();
    const args = request.args;
    const limits = requestLimits(request);
    if (request.command === "roots") {
      return this.buildRoots(await shell.execute(
        buildRootsScript(readNumber(args, "maxFiles")).script,
        limits.timeoutMs,
        limits.maxBytes,
      ));
    }
    if (request.command === "find") {
      return this.buildFind(await shell.execute(buildFindScript({
        root: readString(args, "root"),
        name: readString(args, "name"),
        ...numberField(args, "maxFiles"),
      }).script, limits.timeoutMs, limits.maxBytes));
    }
    if (request.command === "grep") {
      return this.buildGrep(await shell.execute(buildGrepScript({
        root: readString(args, "root"),
        text: readString(args, "text"),
        preview: readBoolean(args, "preview"),
        ...numberField(args, "maxFiles"),
      }).script, limits.timeoutMs, limits.maxBytes), readBoolean(args, "preview"));
    }
    if (request.command === "view") {
      return this.buildView(await shell.execute(buildViewScript({
        file: readString(args, "file"),
        line: readRequiredNumber(args, "line"),
        ...numberField(args, "context"),
      }).script, limits.timeoutMs, limits.maxBytes), readString(args, "file"));
    }
    return this.buildInspect(await shell.execute(buildInspectCandidatesScript({
      text: readString(args, "text"),
      ...stringField(args, "root"),
      ...stringField(args, "name"),
      ...numberField(args, "maxFiles"),
    }).script, limits.timeoutMs, limits.maxBytes));
  }

  private buildRoots(result: PersistentResult): RootsResult {
    return {
      meta: this.meta(result),
      roots: parseRootsOutput(result.stdout),
    };
  }

  private buildFind(result: PersistentResult): FindResult {
    return {
      meta: this.meta(result),
      matches: parseFindOutput(result.stdout, this.bootstrap.instance),
    };
  }

  private buildGrep(result: PersistentResult, includePreview: boolean): GrepResult {
    return {
      meta: this.meta(result),
      matches: parseGrepOutput(result.stdout, this.bootstrap.instance, includePreview),
    };
  }

  private buildView(result: PersistentResult, file: string): ViewResult {
    const lines = parseViewOutput(result.stdout);
    return {
      meta: this.meta(result),
      file,
      startLine: lines[0]?.line ?? 1,
      endLine: lines.at(-1)?.line ?? 1,
      lines,
    };
  }

  private buildInspect(result: PersistentResult): InspectCandidatesResult {
    return {
      meta: this.meta(result),
      ...parseInspectOutput(result.stdout, this.bootstrap.instance, false),
    };
  }

  private meta(result: PersistentResult): ExplorerMeta {
    return {
      target: normalizeTarget(this.bootstrap.target),
      process: this.bootstrap.process,
      instance: this.bootstrap.instance,
      durationMs: result.durationMs,
      truncated: result.truncated,
    };
  }

  private requireShell(): PersistentShell {
    if (this.shell === undefined) {
      throw new CfExplorerError("SESSION_STALE", "Persistent shell is not available.");
    }
    return this.shell;
  }

  private async requireSession(): Promise<ExplorerSessionRecord> {
    const session = await readExplorerSession(this.bootstrap.homeDir, this.bootstrap.sessionId);
    if (session === undefined) {
      throw new CfExplorerError("SESSION_NOT_FOUND", "Session metadata is missing.");
    }
    return session;
  }

  private async prepareContext(): Promise<CfCommandContext> {
    const runtime: ExplorerRuntimeOptions = {
      ...(this.bootstrap.cfBin === undefined ? {} : { cfBin: this.bootstrap.cfBin }),
    };
    const session = await this.requireSession();
    const prepared = await prepareCfCliSession(this.bootstrap.target, session.cfHomeDir, runtime);
    // Auth state is now stored in CF_HOME; clear inherited credentials from
    // process.env so /proc/<pid>/environ does not leak them for the broker
    // lifetime.
    delete process.env["SAP_EMAIL"];
    delete process.env["SAP_PASSWORD"];
    delete process.env["CF_USERNAME"];
    delete process.env["CF_PASSWORD"];
    return prepared.context;
  }

  private async touchLastUsed(): Promise<void> {
    let updated: ExplorerSessionRecord | undefined;
    try {
      updated = await updateExplorerSession(this.bootstrap.homeDir, this.bootstrap.sessionId, {
        lastUsedAt: new Date().toISOString(),
      });
    } catch {
      return;
    }
    if (updated !== undefined) {
      this.session = updated;
    }
  }

  private armTimers(): void {
    this.resetIdleTimer();
    this.hardTimer = setTimeout(() => {
      void this.shutdown();
    }, this.bootstrap.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      void this.shutdown();
    }, this.bootstrap.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  }

  private handleShellExit(reason: string): void {
    void updateExplorerSession(this.bootstrap.homeDir, this.bootstrap.sessionId, {
      status: "stale",
      message: reason,
    }).catch(() => {
      // Best-effort: persistence errors must not loop into shutdown.
    }).finally(() => {
      void this.shutdown(1);
    });
  }

  public async shutdown(exitCode = 0): Promise<void> {
    if (this.shutdownStarted) {
      return;
    }
    this.shutdownStarted = true;
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
    }
    if (this.hardTimer !== undefined) {
      clearTimeout(this.hardTimer);
    }
    this.shell?.stop();
    const removed = await removeExplorerSession(this.bootstrap.homeDir, this.bootstrap.sessionId);
    if (removed !== undefined) {
      await cleanupSessionFiles(removed, this.bootstrap.homeDir);
    }
    process.exit(exitCode);
  }

  private async failStartup(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await updateExplorerSession(this.bootstrap.homeDir, this.bootstrap.sessionId, {
      status: "error",
      message,
    });
  }
}

function readString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CfExplorerError("UNSAFE_INPUT", `${key} is required.`);
  }
  return value;
}

function readOptionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
}

function numberField(args: Record<string, unknown>, key: string): Record<string, number> {
  const value = readNumber(args, key);
  return value === undefined ? {} : { [key]: value };
}

function stringField(args: Record<string, unknown>, key: string): Record<string, string> {
  const value = readOptionalString(args, key);
  return value === undefined ? {} : { [key]: value };
}

function readRequiredNumber(args: Record<string, unknown>, key: string): number {
  const value = readNumber(args, key);
  if (value === undefined) {
    throw new CfExplorerError("UNSAFE_INPUT", `${key} is required.`);
  }
  return value;
}

function readBoolean(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

function requestLimits(request: IpcRequest): {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
} {
  return {
    ...positiveIntegerField(request.timeoutMs, "timeoutMs"),
    ...positiveIntegerField(request.args["maxBytes"], "maxBytes"),
  };
}

function positiveIntegerField(value: unknown, key: string): Record<string, number> {
  if (value === undefined) {
    return {};
  }
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    throw new CfExplorerError("UNSAFE_INPUT", `${key} must be a positive integer.`);
  }
  return { [key]: value };
}

function normalizeBrokerError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new CfExplorerError("BROKER_UNAVAILABLE", String(error));
}

function parseBootstrap(raw: string | undefined): BrokerBootstrap {
  if (raw === undefined || raw.length === 0) {
    throw new CfExplorerError("BROKER_UNAVAILABLE", "Missing broker bootstrap payload.");
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isBootstrap(parsed)) {
    throw new CfExplorerError("BROKER_UNAVAILABLE", "Invalid broker bootstrap payload.");
  }
  return parsed;
}

function isBootstrap(value: unknown): value is BrokerBootstrap {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<BrokerBootstrap>;
  const target = (value as { readonly target?: unknown }).target;
  return (
    typeof candidate.sessionId === "string" &&
    typeof candidate.homeDir === "string" &&
    typeof candidate.process === "string" &&
    typeof candidate.instance === "number" &&
    typeof target === "object" &&
    target !== null
  );
}

function ignoreQueueResult(): void {
  return;
}

function shutdownActiveBroker(exitCode: number): void {
  if (activeBroker === undefined) {
    process.exit(exitCode);
  }
  void activeBroker.shutdown(exitCode);
}

process.on("SIGTERM", () => {
  shutdownActiveBroker(0);
});

process.on("SIGINT", () => {
  shutdownActiveBroker(130);
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runBrokerFromEnv();
}
