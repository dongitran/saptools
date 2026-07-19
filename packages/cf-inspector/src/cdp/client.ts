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

export interface CdpTransportFactoryOptions {
  readonly connectTimeoutMs?: number;
}

export type CdpTransportFactory = (
  url: string,
  options?: CdpTransportFactoryOptions,
) => Promise<CdpTransport>;

export interface CdpClientOptions {
  readonly url: string;
  readonly transportFactory?: CdpTransportFactory;
  readonly requestTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}

export interface CdpWaitOptions<T> {
  readonly timeoutMs: number;
  readonly predicate?: (params: T) => boolean;
  readonly signal?: AbortSignal;
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

interface NodeWorkerEventParams {
  readonly sessionId?: unknown;
  readonly message?: unknown;
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
      // A throwing listener must not crash the WS message pipeline. Without
      // this guard, EventEmitter rethrows on the first uncaught listener
      // exception and the rest of the dispatch stops — including downstream
      // listeners that need to settle pending requests.
      this.safeEmit(parsed.method, parsed.params);
      this.safeEmit("event", { method: parsed.method, params: parsed.params });
    }
  };

  private safeEmit(event: string, payload: unknown): void {
    // EventEmitter.emit re-throws on the first listener's exception and skips
    // the rest. Iterate explicitly so one bad listener does not deny later
    // listeners (e.g. the pause buffer pusher) from observing the event.
    const listeners = this.emitter.listeners(event);
    for (const listener of listeners) {
      try {
        (listener as (payload: unknown) => void)(payload);
      } catch {
        // Listener exceptions are caller bugs; swallow to keep the pipeline alive.
      }
    }
  }

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
    const factoryOptions: CdpTransportFactoryOptions =
      options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs };
    const transport = await factory(options.url, factoryOptions);
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
    options: CdpWaitOptions<T> = {
      timeoutMs: this.requestTimeoutMs,
    },
  ): Promise<T> {
    if (this.closed) {
      throw this.closeReason ?? new CfInspectorError("INSPECTOR_CONNECTION_FAILED", "Connection closed");
    }
    if (options.signal?.aborted === true) {
      throw this.createWaitAbortError(method);
    }
    return await this.createEventWait(method, options);
  }

  private createEventWait<T>(method: string, options: CdpWaitOptions<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let offEvent = (): void => undefined;
      let offClose = (): void => undefined;
      const cleanup = (): void => {
        clearTimeout(timer);
        offEvent();
        offClose();
        options.signal?.removeEventListener("abort", onAbort);
      };
      const resolveOnce = (value: T): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      };
      const rejectOnce = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        rejectOnce(this.createWaitAbortError(method));
      };
      const timer = setTimeout(() => {
        rejectOnce(this.createWaitTimeoutError(method, options.timeoutMs));
      }, options.timeoutMs);
      offEvent = this.on(method, (raw) => {
        const params = raw as T;
        if (!this.eventMatches(params, options.predicate)) {
          return;
        }
        resolveOnce(params);
      });
      offClose = this.onClose((error) => {
        rejectOnce(error);
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted === true) {
        onAbort();
      }
    });
  }

  private eventMatches<T>(params: T, predicate: ((params: T) => boolean) | undefined): boolean {
    if (predicate === undefined) {
      return true;
    }
    try {
      return predicate(params);
    } catch {
      return false;
    }
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

  private createWaitAbortError(method: string): CfInspectorError {
    return new CfInspectorError("ABORTED", `Aborted while waiting for ${method}`);
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

class NodeWorkerTransport implements CdpTransport {
  private readonly emitter = new EventEmitter();
  private readonly detachParentListeners: readonly (() => void)[];
  public readyState = 1;

  public constructor(
    private readonly parent: CdpClient,
    private readonly sessionId: string,
  ) {
    this.detachParentListeners = [
      parent.on("NodeWorker.receivedMessageFromWorker", (raw) => {
        this.forwardWorkerMessage(raw);
      }),
      parent.on("NodeWorker.detachedFromWorker", (raw) => {
        this.handleWorkerDetach(raw);
      }),
      parent.onClose((error) => {
        this.closeWithError(error);
      }),
    ];
  }

  public send(payload: string): void {
    if (this.readyState !== 1) {
      throw new CfInspectorError("INSPECTOR_CONNECTION_FAILED", "Worker inspector session is closed");
    }
    void this.parent.send("NodeWorker.sendMessageToWorker", {
      sessionId: this.sessionId,
      message: payload,
    }).catch((error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.closeWithError(normalized);
    });
  }

  public close(): void {
    this.finishClose();
  }

  public on<E extends keyof CdpTransportEventMap>(
    event: E,
    listener: CdpTransportEventMap[E],
  ): void {
    this.emitter.on(event, listener);
  }

  public off<E extends keyof CdpTransportEventMap>(
    event: E,
    listener: CdpTransportEventMap[E],
  ): void {
    this.emitter.off(event, listener);
  }

  private forwardWorkerMessage(raw: unknown): void {
    const params = asNodeWorkerEventParams(raw);
    if (params.sessionId !== this.sessionId || typeof params.message !== "string") {
      return;
    }
    this.emitter.emit("message", params.message);
  }

  private handleWorkerDetach(raw: unknown): void {
    const params = asNodeWorkerEventParams(raw);
    if (params.sessionId === this.sessionId) {
      this.finishClose();
    }
  }

  private closeWithError(error: Error): void {
    if (this.readyState !== 1) {
      return;
    }
    this.emitter.emit("error", error);
    this.finishClose();
  }

  private finishClose(): void {
    if (this.readyState !== 1) {
      return;
    }
    this.readyState = 3;
    for (const detach of this.detachParentListeners) {
      detach();
    }
    this.emitter.emit("close");
    this.emitter.removeAllListeners();
  }
}

function asNodeWorkerEventParams(raw: unknown): NodeWorkerEventParams {
  if (!isUnknownRecord(raw)) {
    return {};
  }
  const sessionId = raw["sessionId"];
  const message = raw["message"];
  return {
    ...(typeof sessionId === "string" ? { sessionId } : {}),
    ...(typeof message === "string" ? { message } : {}),
  };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function createNodeWorkerClient(
  parent: CdpClient,
  sessionId: string,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<CdpClient> {
  const transport = new NodeWorkerTransport(parent, sessionId);
  return await CdpClient.connect({
    url: `node-worker://${sessionId}`,
    transportFactory: (): Promise<CdpTransport> => Promise.resolve(transport),
    requestTimeoutMs,
  });
}
