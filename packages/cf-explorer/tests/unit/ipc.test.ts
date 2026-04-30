import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CfExplorerError } from "../../src/errors.js";
import { createIpcServer, errorResponse, sendIpcRequest } from "../../src/ipc.js";

const SMALL_IPC_LIMIT_BYTES = 64;

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

  it("drains multiple newline-delimited requests received in one chunk", async () => {
    const socketPath = join(dir, "drain.sock");
    const seen: string[] = [];
    server = await createIpcServer(socketPath, async (request) => {
      seen.push(request.requestId);
      return { requestId: request.requestId, ok: true, durationMs: 0, result: {} };
    });

    const responses = await new Promise<string[]>((resolve) => {
      const socket = createConnection(socketPath);
      let buffer = "";
      const collected: string[] = [];
      socket.on("connect", () => {
        const requestA = JSON.stringify({
          requestId: "req-a",
          sessionId: "session-a",
          command: "roots",
          args: {},
        });
        const requestB = JSON.stringify({
          requestId: "req-b",
          sessionId: "session-a",
          command: "roots",
          args: {},
        });
        socket.write(`${requestA}\n${requestB}\n`);
      });
      socket.on("data", (chunk: Buffer | string) => {
        buffer += chunk.toString();
        let lineEnd = buffer.indexOf("\n");
        while (lineEnd >= 0) {
          collected.push(buffer.slice(0, lineEnd));
          buffer = buffer.slice(lineEnd + 1);
          lineEnd = buffer.indexOf("\n");
          if (collected.length === 2) {
            socket.end();
            resolve(collected);
            return;
          }
        }
      });
    });
    expect(seen).toEqual(["req-a", "req-b"]);
    expect(responses).toHaveLength(2);
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

  it("rejects oversized broker responses", async () => {
    const socketPath = join(dir, "oversized-response.sock");
    server = createServer((socket) => {
      socket.on("data", () => {
        socket.write("x".repeat(SMALL_IPC_LIMIT_BYTES + 1));
      });
    });
    await new Promise<void>((resolve) => {
      server?.listen(socketPath, () => {
        resolve();
      });
    });

    await expect(sendIpcRequest(socketPath, {
      requestId: "request-big",
      sessionId: "session-a",
      command: "roots",
      args: {},
    }, { maxMessageBytes: SMALL_IPC_LIMIT_BYTES })).rejects.toMatchObject({
      code: "IPC_FAILED",
      message: "Broker response exceeded IPC size limit.",
    });
  });

  it("returns a structured error for oversized broker requests", async () => {
    const socketPath = join(dir, "oversized-request.sock");
    server = await createIpcServer(
      socketPath,
      async () => ({
        requestId: "unreachable",
        ok: true,
        durationMs: 0,
      }),
      { maxMessageBytes: SMALL_IPC_LIMIT_BYTES },
    );

    const response = await new Promise<string>((resolve) => {
      const socket = createConnection(socketPath);
      let buffer = "";
      socket.on("connect", () => {
        socket.write("x".repeat(SMALL_IPC_LIMIT_BYTES + 1));
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
      error: {
        code: "IPC_FAILED",
        message: "Broker request exceeded IPC size limit.",
      },
    });
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
