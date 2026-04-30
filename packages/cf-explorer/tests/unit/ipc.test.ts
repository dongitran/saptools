import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CfExplorerError } from "../../src/errors.js";
import { createIpcServer, errorResponse, sendIpcRequest } from "../../src/ipc.js";

describe("IPC transport", () => {
  let dir: string;
  let server: Server | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cf-explorer-ipc-"));
  });

  afterEach(async () => {
    server?.close();
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips newline-delimited JSON requests", async () => {
    const socketPath = join(dir, "session.sock");
    server = await createIpcServer(socketPath, async (request) => ({
      requestId: request.requestId,
      ok: true,
      durationMs: 2,
      result: { command: request.command },
    }));

    await expect(sendIpcRequest(socketPath, {
      requestId: "request-a",
      sessionId: "session-a",
      command: "roots",
      args: {},
    })).resolves.toMatchObject({
      requestId: "request-a",
      ok: true,
      result: { command: "roots" },
    });
  });

  it("turns handler failures into structured responses", async () => {
    const socketPath = join(dir, "error.sock");
    server = await createIpcServer(socketPath, async () => {
      throw new CfExplorerError("UNSAFE_INPUT", "bad request");
    });

    const response = await sendIpcRequest(socketPath, {
      requestId: "request-b",
      sessionId: "session-a",
      command: "roots",
      args: {},
    });
    expect(response).toMatchObject({
      ok: false,
      error: { code: "UNSAFE_INPUT", message: "bad request" },
    });
  });

  it("rejects malformed broker requests before they reach handlers", async () => {
    const socketPath = join(dir, "malformed.sock");
    server = await createIpcServer(socketPath, async () => ({
      requestId: "unreachable",
      ok: true,
      durationMs: 0,
    }));

    const response = await new Promise<string>((resolve) => {
      const socket = createConnection(socketPath);
      let buffer = "";
      socket.on("connect", () => {
        socket.write("{\"bad\":true}\n");
      });
      socket.on("data", (chunk: Buffer | string) => {
        buffer += chunk.toString();
        if (buffer.includes("\n")) {
          socket.end();
          resolve(buffer);
        }
      });
    });
    expect(JSON.parse(response) as unknown).toMatchObject({
      requestId: "unknown",
      ok: false,
      error: { code: "IPC_FAILED" },
    });
  });

  it("builds typed error responses", () => {
    expect(errorResponse("request-c", new CfExplorerError("IPC_FAILED", "no socket")))
      .toMatchObject({ requestId: "request-c", ok: false, error: { code: "IPC_FAILED" } });
  });

  it("rejects invalid broker responses", async () => {
    const socketPath = join(dir, "invalid.sock");
    server = createServer((socket) => {
      socket.write("{\"ok\":true}\n");
      socket.end();
    });
    await new Promise<void>((resolve) => {
      server?.listen(socketPath, () => {
        resolve();
      });
    });

    await expect(sendIpcRequest(socketPath, {
      requestId: "request-d",
      sessionId: "session-a",
      command: "roots",
      args: {},
    })).rejects.toMatchObject({ code: "IPC_FAILED" });
  });

  it("reports connection errors as IPC failures", async () => {
    await expect(sendIpcRequest(join(dir, "missing.sock"), {
      requestId: "request-e",
      sessionId: "session-a",
      command: "roots",
      args: {},
      timeoutMs: 50,
    })).rejects.toMatchObject({ code: "IPC_FAILED" });
  });
});
