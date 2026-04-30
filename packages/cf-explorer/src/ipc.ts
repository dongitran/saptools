import { mkdir } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import { CfExplorerError } from "./errors.js";

export const IPC_COMMANDS = ["find", "grep", "inspect", "roots", "status", "stop", "view"] as const;
export type IpcCommand = (typeof IPC_COMMANDS)[number];

export interface IpcRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly command: IpcCommand;
  readonly args: Record<string, unknown>;
  readonly timeoutMs?: number;
}

export interface IpcResponse {
  readonly requestId: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly result?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export type IpcHandler = (request: IpcRequest) => Promise<IpcResponse>;

export async function createIpcServer(
  socketPath: string,
  handler: IpcHandler,
): Promise<Server> {
  if (process.platform !== "win32") {
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  }
  const server = createServer((socket) => {
    attachSocketHandler(socket, handler);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

export async function sendIpcRequest(socketPath: string, request: IpcRequest): Promise<IpcResponse> {
  return await new Promise<IpcResponse>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new CfExplorerError("IPC_FAILED", "Timed out waiting for broker response."));
    }, request.timeoutMs ?? 30_000);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd >= 0) {
        clearTimeout(timeout);
        socket.end();
        try {
          resolve(parseIpcResponse(buffer.slice(0, lineEnd)));
        } catch (error: unknown) {
          reject(error instanceof Error ? error : new CfExplorerError("IPC_FAILED", String(error)));
        }
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(new CfExplorerError("IPC_FAILED", error.message));
    });
  });
}

function attachSocketHandler(socket: Socket, handler: IpcHandler): void {
  let buffer = "";
  socket.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lineEnd = buffer.indexOf("\n");
    if (lineEnd < 0) {
      return;
    }
    const line = buffer.slice(0, lineEnd);
    buffer = buffer.slice(lineEnd + 1);
    void respondToRequest(socket, handler, line);
  });
}

async function respondToRequest(socket: Socket, handler: IpcHandler, line: string): Promise<void> {
  try {
    const request = parseIpcRequest(line);
    const response = await handler(request);
    socket.write(`${JSON.stringify(response)}\n`);
  } catch (error: unknown) {
    const explorerError = error instanceof CfExplorerError
      ? error
      : new CfExplorerError("IPC_FAILED", error instanceof Error ? error.message : String(error));
    socket.write(`${JSON.stringify(errorResponse("unknown", explorerError))}\n`);
  }
}

function parseIpcRequest(raw: string): IpcRequest {
  const parsed = JSON.parse(raw) as unknown;
  if (!isIpcRequest(parsed)) {
    throw new CfExplorerError("IPC_FAILED", "Invalid broker request.");
  }
  return parsed;
}

function parseIpcResponse(raw: string): IpcResponse {
  const parsed = JSON.parse(raw) as unknown;
  if (!isIpcResponse(parsed)) {
    throw new CfExplorerError("IPC_FAILED", "Invalid broker response.");
  }
  return parsed;
}

export function errorResponse(requestId: string, error: CfExplorerError): IpcResponse {
  return {
    requestId,
    ok: false,
    durationMs: 0,
    error: { code: error.code, message: error.message },
  };
}

function isIpcRequest(value: unknown): value is IpcRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<IpcRequest>;
  const args = (value as { readonly args?: unknown }).args;
  return (
    typeof candidate.requestId === "string" &&
    typeof candidate.sessionId === "string" &&
    isIpcCommand(candidate.command) &&
    typeof args === "object" &&
    args !== null
  );
}

function isIpcResponse(value: unknown): value is IpcResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<IpcResponse>;
  return typeof candidate.requestId === "string" && typeof candidate.ok === "boolean";
}

function isIpcCommand(value: unknown): value is IpcCommand {
  return typeof value === "string" && IPC_COMMANDS.includes(value as IpcCommand);
}
