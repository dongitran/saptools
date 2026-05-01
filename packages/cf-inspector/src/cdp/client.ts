import { EventEmitter } from "node:events";

import { CfInspectorError } from "../types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface CdpTransportEventMap {
  readonly message: (data: string) => void;
  readonly close: () => void;
  readonly error: (err: Error) => void;
}

export interface CdpTransport {
  send(payload: string): void;
  close(): void;
  readonly readyState: number;
  on<E extends keyof CdpTransportEventMap>(event: E, listener: CdpTransportEventMap[E]): void;
  off<E extends keyof CdpTransportEventMap>(event: E, listener: CdpTransportEventMap[E]): void;
}

export type CdpTransportFactory = (url: string) => Promise<CdpTransport>;

export interface CdpClientOptions {
  readonly url: string;
  readonly transportFactory?: CdpTransportFactory;
  readonly requestTimeoutMs?: number;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ParsedMessage {
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
  readonly params?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

function parseMessage(raw: string): ParsedMessage | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    return value as ParsedMessage;
  } catch {
    return undefined;
  }
}

async function loadDefaultFactory(): Promise<CdpTransportFactory> {
  const mod = await import("./wsTransport.js");
  return mod.wsTransportFactory;
}

export class CdpClient {
  private readonly transport: CdpTransport;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly emitter = new EventEmitter();
  private nextId = 1;
  private closed = false;
  private closeReason: Error | undefined;

  private readonly handleMessage = (raw: string): void => {
    const parsed = parseMessage(raw);
    if (!parsed) {
      return;
    }
    if (typeof parsed.id === "number") {
      this.handleResponse(parsed);
      return;
    }
    if (typeof parsed.method === "string") {
      this.emitter.emit(parsed.method, parsed.params);
      this.emitter.emit("event", { method: parsed.method, params: parsed.params });
    }
  };

  private readonly handleClose = (): void => {
    this.markClosed(new CfInspectorError("INSPECTOR_CONNECTION_FAILED", "Inspector connection closed"));
  };

  private readonly handleError = (err: Error): void => {
    this.markClosed(
      err instanceof CfInspectorError
        ? err
        : new CfInspectorError("INSPECTOR_CONNECTION_FAILED", err.message),
    );
  };

  private constructor(transport: CdpTransport, requestTimeoutMs: number) {
    this.transport = transport;
    this.requestTimeoutMs = requestTimeoutMs;
    transport.on("message", this.handleMessage);
    transport.on("close", this.handleClose);
    transport.on("error", this.handleError);
  }

  public static async connect(options: CdpClientOptions): Promise<CdpClient> {
    const factory = options.transportFactory ?? (await loadDefaultFactory());
    const transport = await factory(options.url);
    return new CdpClient(transport, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  }

  public async send<TResult = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<TResult> {
    if (this.closed) {
      throw this.closeReason ?? new CfInspectorError("INSPECTOR_CONNECTION_FAILED", "Connection closed");
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return await new Promise<TResult>((resolve, reject) => {
      const timer = this.createRequestTimer(id, method, reject);
      this.pending.set(id, {
        resolve: (value): void => {
          resolve(value as TResult);
        },
        reject,
        timer,
      });
      this.sendPayload(id, method, payload, timer, reject);
    });
  }

  public on(method: string, listener: (params: unknown) => void): () => void {
    this.emitter.on(method, listener);
    return (): void => {
      this.emitter.off(method, listener);
    };
  }

  public async waitFor<T = unknown>(
    method: string,
    options: { readonly timeoutMs: number; readonly predicate?: (params: T) => boolean } = {
      timeoutMs: this.requestTimeoutMs,
    },
  ): Promise<T> {
    if (this.closed) {
      throw this.closeReason ?? new CfInspectorError("INSPECTOR_CONNECTION_FAILED", "Connection closed");
    }
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        offEvent();
        offClose();
      };
      const finish = (value: T): void => {
        settled = true;
        cleanup();
        resolve(value);
      };
      const offEvent = this.on(method, (raw) => {
        if (settled) {
          return;
        }
        const params = raw as T;
        if (options.predicate && !options.predicate(params)) {
          return;
        }
        finish(params);
      });
      const offClose = this.onClose((err) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(err);
      });
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(this.createWaitTimeoutError(method, options.timeoutMs));
      }, options.timeoutMs);
    });
  }

  public onClose(listener: (err: Error) => void): () => void {
    if (this.closed) {
      const reason = this.closeReason ?? new CfInspectorError("INSPECTOR_CONNECTION_FAILED", "Connection closed");
      queueMicrotask(() => {
        listener(reason);
      });
      return (): void => {
        // already closed; nothing to detach
      };
    }
    this.emitter.on("__close__", listener);
    return (): void => {
      this.emitter.off("__close__", listener);
    };
  }

  public dispose(): void {
    if (this.closed) {
      return;
    }
    this.transport.off("message", this.handleMessage);
    this.transport.off("close", this.handleClose);
    this.transport.off("error", this.handleError);
    try {
      this.transport.close();
    } catch {
      // best-effort
    }
    this.markClosed(new CfInspectorError("INSPECTOR_CONNECTION_FAILED", "Connection disposed"));
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  private handleResponse(parsed: ParsedMessage): void {
    const pending = this.pending.get(parsed.id ?? -1);
    if (!pending) {
      return;
    }
    this.pending.delete(parsed.id ?? -1);
    clearTimeout(pending.timer);
    if (parsed.error) {
      pending.reject(
        new CfInspectorError(
          "CDP_REQUEST_FAILED",
          `CDP request ${(parsed.id ?? -1).toString()} failed: ${parsed.error.message}`,
          JSON.stringify(parsed.error),
        ),
      );
      return;
    }
    pending.resolve(parsed.result);
  }

  private createRequestTimer(
    id: number,
    method: string,
    reject: (error: Error) => void,
  ): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.pending.delete(id);
      reject(
        new CfInspectorError(
          "CDP_REQUEST_FAILED",
          `CDP method ${method} timed out after ${this.requestTimeoutMs.toString()}ms`,
        ),
      );
    }, this.requestTimeoutMs);
  }

  private createWaitTimeoutError(method: string, timeoutMs: number): CfInspectorError {
    return new CfInspectorError(
      "BREAKPOINT_NOT_HIT",
      `Timed out waiting for ${method} after ${timeoutMs.toString()}ms`,
    );
  }

  private sendPayload(
    id: number,
    method: string,
    payload: string,
    timer: ReturnType<typeof setTimeout>,
    reject: (error: Error) => void,
  ): void {
    try {
      this.transport.send(payload);
    } catch (err: unknown) {
      clearTimeout(timer);
      this.pending.delete(id);
      const message = err instanceof Error ? err.message : String(err);
      reject(new CfInspectorError("CDP_REQUEST_FAILED", `Failed to send ${method}: ${message}`));
    }
  }

  private markClosed(reason: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeReason = reason;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    this.emitter.emit("__close__", reason);
    this.emitter.removeAllListeners();
  }
}
