import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { CfExplorerError } from "../core/errors.js";

import {
  parseProtocolFrame,
  requireSuccessfulFrame,
  wrapRemoteScript,
  type WrappedRemoteCommand,
} from "./protocol.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export interface PersistentResult {
  readonly stdout: string;
  readonly durationMs: number;
  readonly truncated: boolean;
}

export class PersistentShell {
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

  public execute(
    script: string,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
  ): Promise<PersistentResult> {
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
      this.rejectPending(normalizeShellError(error));
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
      pending.reject(normalizeShellError(error));
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

function normalizeShellError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new CfExplorerError("BROKER_UNAVAILABLE", String(error));
}

function ignoreQueueResult(): void {
  return;
}
