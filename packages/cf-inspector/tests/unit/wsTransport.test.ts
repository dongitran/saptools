import { createServer } from "node:net";
import type { Server, Socket } from "node:net";

import { describe, expect, it } from "vitest";

import { wsTransportFactory } from "../../src/cdp/wsTransport.js";
import { CfInspectorError } from "../../src/types.js";

interface HangingTcp {
  readonly port: number;
  close(): Promise<void>;
}

async function startHangingTcpServer(): Promise<HangingTcp> {
  // Accepts the TCP connection but never sends an HTTP response, so the WS
  // handshake will hang indefinitely without a client-side timeout.
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("test server did not bind to a TCP address");
  }
  return {
    port: address.port,
    close: async () => {
      // server.close() waits for in-flight sockets to drain. Force-destroy
      // them so the test does not hang on lingering connections.
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

describe("wsTransportFactory connect timeout", () => {
  it("rejects with INSPECTOR_CONNECTION_FAILED when the handshake exceeds connectTimeoutMs", async () => {
    const tcp = await startHangingTcpServer();
    try {
      await expect(
        wsTransportFactory(`ws://127.0.0.1:${tcp.port.toString()}`, { connectTimeoutMs: 50 }),
      ).rejects.toMatchObject({
        code: "INSPECTOR_CONNECTION_FAILED",
        message: expect.stringContaining("timed out after 50ms") as unknown as string,
      });
    } finally {
      await tcp.close();
    }
  });

  it("rejects with INSPECTOR_CONNECTION_FAILED when the URL is unreachable", async () => {
    // 127.0.0.1:1 is reserved (tcpmux); kernel either rejects or refuses the
    // connection synchronously. Either way the WS client raises an error,
    // which we wrap with our error code.
    await expect(
      wsTransportFactory("ws://127.0.0.1:1", { connectTimeoutMs: 200 }),
    ).rejects.toBeInstanceOf(CfInspectorError);
  });
});
