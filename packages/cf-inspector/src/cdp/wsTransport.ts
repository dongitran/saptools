import { WebSocket } from "ws";

import { CfInspectorError } from "../types.js";

import type { CdpTransport, CdpTransportEventMap } from "./client.js";

export interface WsTransportOptions {
  readonly connectTimeoutMs?: number;
}

export async function wsTransportFactory(
  url: string,
  options: WsTransportOptions = {},
): Promise<CdpTransport> {
  const socket = new WebSocket(url, { perMessageDeflate: false });
  await waitForOpen(socket, url, options.connectTimeoutMs);
  // Keyed by `(event, listener)` — registering the same listener function for
  // two different events must produce two distinct wrappers; otherwise `off`
  // for one event would unsubscribe the wrong wrapper.
  const wrappers = new Map<keyof CdpTransportEventMap, WeakMap<object, (...args: unknown[]) => void>>();

  function wrappersFor(event: keyof CdpTransportEventMap): WeakMap<object, (...args: unknown[]) => void> {
    const existing = wrappers.get(event);
    if (existing !== undefined) {
      return existing;
    }
    const created = new WeakMap<object, (...args: unknown[]) => void>();
    wrappers.set(event, created);
    return created;
  }

  return {
    send(payload: string): void {
      socket.send(payload);
    },
    close(): void {
      socket.close();
    },
    get readyState(): number {
      return socket.readyState;
    },
    on(event, listener): void {
      const wrapped = wrapListener(event, listener);
      wrappersFor(event).set(listener as object, wrapped);
      socket.on(event, wrapped);
    },
    off(event, listener): void {
      const wrapped = wrappersFor(event).get(listener as object);
      if (!wrapped) {
        return;
      }
      socket.off(event, wrapped);
    },
  };
}

async function waitForOpen(socket: WebSocket, url: string, timeoutMs: number | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      socket.off("open", onOpen);
      socket.off("error", onError);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
    const onOpen = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(
        new CfInspectorError(
          "INSPECTOR_CONNECTION_FAILED",
          `Failed to connect to inspector at ${url}: ${err.message}`,
        ),
      );
    };
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      // Absorb the 'error' event that ws emits asynchronously when terminate()
      // races an in-flight handshake. Without this swallower the post-cleanup
      // error becomes an unhandled exception.
      socket.on("error", () => {
        // swallow
      });
      try {
        socket.terminate();
      } catch {
        // best-effort
      }
      reject(
        new CfInspectorError(
          "INSPECTOR_CONNECTION_FAILED",
          `WebSocket handshake to ${url} timed out after ${timeoutMs.toString()}ms`,
        ),
      );
    }, timeoutMs);
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

function wrapListener<E extends keyof CdpTransportEventMap>(
  event: E,
  listener: CdpTransportEventMap[E],
): (...args: unknown[]) => void {
  if (event === "message") {
    const wrapped = (data: Buffer): void => {
      (listener as CdpTransportEventMap["message"])(data.toString("utf8"));
    };
    return wrapped as (...args: unknown[]) => void;
  }
  if (event === "close") {
    const wrapped = (): void => {
      (listener as CdpTransportEventMap["close"])();
    };
    return wrapped as (...args: unknown[]) => void;
  }
  const wrapped = (err: Error): void => {
    (listener as CdpTransportEventMap["error"])(err);
  };
  return wrapped as (...args: unknown[]) => void;
}
