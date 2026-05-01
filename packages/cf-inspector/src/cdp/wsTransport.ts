import { WebSocket } from "ws";

import { CfInspectorError } from "../types.js";

import type { CdpTransport, CdpTransportEventMap } from "./client.js";

export async function wsTransportFactory(url: string): Promise<CdpTransport> {
  const socket = new WebSocket(url, { perMessageDeflate: false });
  await waitForOpen(socket, url);
  const wrappers = new WeakMap<object, (...args: unknown[]) => void>();

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
      const wrapped = wrapListener(event, listener, wrappers);
      socket.on(event, wrapped);
    },
    off(event, listener): void {
      const wrapped = wrappers.get(listener as object);
      if (!wrapped) {
        return;
      }
      socket.off(event, wrapped);
    },
  };
}

async function waitForOpen(socket: WebSocket, url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (err: Error): void => {
      socket.off("open", onOpen);
      reject(
        new CfInspectorError(
          "INSPECTOR_CONNECTION_FAILED",
          `Failed to connect to inspector at ${url}: ${err.message}`,
        ),
      );
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

function wrapListener<E extends keyof CdpTransportEventMap>(
  event: E,
  listener: CdpTransportEventMap[E],
  wrappers: WeakMap<object, (...args: unknown[]) => void>,
): (...args: unknown[]) => void {
  if (event === "message") {
    const wrapped = (data: Buffer): void => {
      (listener as CdpTransportEventMap["message"])(data.toString("utf8"));
    };
    wrappers.set(listener as object, wrapped as (...args: unknown[]) => void);
    return wrapped as (...args: unknown[]) => void;
  }
  if (event === "close") {
    const wrapped = (): void => {
      (listener as CdpTransportEventMap["close"])();
    };
    wrappers.set(listener as object, wrapped as (...args: unknown[]) => void);
    return wrapped as (...args: unknown[]) => void;
  }
  const wrapped = (err: Error): void => {
    (listener as CdpTransportEventMap["error"])(err);
  };
  wrappers.set(listener as object, wrapped as (...args: unknown[]) => void);
  return wrapped as (...args: unknown[]) => void;
}
