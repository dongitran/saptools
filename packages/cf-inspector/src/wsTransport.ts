import { WebSocket } from "ws";

import type { CdpTransport, CdpTransportEventMap } from "./cdp.js";
import { CfInspectorError } from "./types.js";

export async function wsTransportFactory(url: string): Promise<CdpTransport> {
  const socket = new WebSocket(url, { perMessageDeflate: false });
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
  const wrappers = new WeakMap<object, (...args: unknown[]) => void>();
  const wrapMessage = (listener: (data: string) => void): ((data: Buffer) => void) => {
    const wrapped = (data: Buffer): void => {
      listener(data.toString("utf8"));
    };
    wrappers.set(listener, wrapped as (...args: unknown[]) => void);
    return wrapped;
  };
  const wrapClose = (listener: () => void): (() => void) => {
    const wrapped = (): void => {
      listener();
    };
    wrappers.set(listener, wrapped as (...args: unknown[]) => void);
    return wrapped;
  };
  const wrapError = (listener: (err: Error) => void): ((err: Error) => void) => {
    const wrapped = (err: Error): void => {
      listener(err);
    };
    wrappers.set(listener, wrapped as (...args: unknown[]) => void);
    return wrapped;
  };

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
      if (event === "message") {
        socket.on("message", wrapMessage(listener as CdpTransportEventMap["message"]));
      } else if (event === "close") {
        socket.on("close", wrapClose(listener as CdpTransportEventMap["close"]));
      } else {
        socket.on("error", wrapError(listener as CdpTransportEventMap["error"]));
      }
    },
    off(event, listener): void {
      const wrapped = wrappers.get(listener as object);
      if (!wrapped) {
        return;
      }
      if (event === "message") {
        socket.off("message", wrapped as (data: Buffer) => void);
      } else if (event === "close") {
        socket.off("close", wrapped as () => void);
      } else {
        socket.off("error", wrapped as (err: Error) => void);
      }
    },
  };
}
