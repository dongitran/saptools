import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyPortOwnership,
  findListeningProcessId,
  findListeningProcessIds,
  inspectListeningProcesses,
  inspectPortOwnership,
  isPortFree,
  parseWindowsNetstatListeningPids,
  probeInspectorReady,
  probeTunnelReady,
} from "../../src/network/ports.js";

async function listenNetServer(server: NetServer, port = 0): Promise<number> {
  return await new Promise<number>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address !== null && typeof address === "object") {
        resolve(address.port);
      }
    });
  });
}

async function listenHttpServer(server: HttpServer): Promise<number> {
  return await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address !== null && typeof address === "object") {
        resolve(address.port);
      }
    });
  });
}

async function closeNetServer(server: NetServer): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function reserveFreePort(): Promise<number> {
  const server = createNetServer();
  const port = await listenNetServer(server);
  await closeNetServer(server);
  return port;
}

async function probeJsonBody(body: string): Promise<"ready" | "unreachable"> {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  });
  const port = await listenHttpServer(server);
  try {
    const result = await probeInspectorReady(port, 200);
    return result.status;
  } finally {
    await closeHttpServer(server);
  }
}

describe("isPortFree", () => {
  let server: NetServer | undefined;

  afterEach(async () => {
    if (server) {
      await closeNetServer(server);
      server = undefined;
    }
  });

  it("returns true when nothing is listening", async () => {
    const port = await reserveFreePort();
    await expect(isPortFree(port)).resolves.toBe(true);
  });

  it("returns false when a server is bound on the port", async () => {
    server = createNetServer();
    const port = await listenNetServer(server);
    await expect(isPortFree(port)).resolves.toBe(false);
  });

  it("honours an already-aborted startup signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(isPortFree(21_995, controller.signal)).rejects.toMatchObject({
      code: "ABORTED",
    });
  });
});

describe("probeTunnelReady", () => {
  it("returns true when the port becomes connectable within the timeout", async () => {
    const server = createNetServer();
    const port = await listenNetServer(server);
    try {
      await expect(probeTunnelReady(port, 2_000)).resolves.toBe(true);
    } finally {
      await closeNetServer(server);
    }
  });

  it("returns false when no server ever comes up", async () => {
    const port = await reserveFreePort();
    await expect(probeTunnelReady(port, 200)).resolves.toBe(false);
  });

  it("returns true when the port becomes connectable after polling starts", async () => {
    const port = await reserveFreePort();
    const server = createNetServer();
    const timer = setTimeout(() => {
      server.listen(port, "127.0.0.1");
    }, 50);

    try {
      await expect(probeTunnelReady(port, 2_000)).resolves.toBe(true);
    } finally {
      clearTimeout(timer);
      await closeNetServer(server);
    }
  });

  it("returns false when the timeout elapses before polling can connect", async () => {
    const port = await reserveFreePort();
    await expect(probeTunnelReady(port, 1)).resolves.toBe(false);
  });

  it("rejects immediately when tunnel probing is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(probeTunnelReady(21_996, 60_000, controller.signal)).rejects.toMatchObject({
      code: "ABORTED",
    });
  });

  it("stops tunnel probing when the caller aborts an active wait", async () => {
    const controller = new AbortController();
    const port = await reserveFreePort();
    const probing = probeTunnelReady(port, 60_000, controller.signal);
    controller.abort();

    await expect(probing).rejects.toMatchObject({ code: "ABORTED" });
  });
});

describe("probeInspectorReady", () => {
  it("rejects a bound forwarder whose downstream inspector is absent", async () => {
    const server = createNetServer((socket) => {
      socket.destroy();
    });
    const port = await listenNetServer(server);
    try {
      await expect(probeTunnelReady(port, 200)).resolves.toBe(true);
      await expect(probeInspectorReady(port, 300)).resolves.toEqual({
        status: "unreachable",
      });
    } finally {
      await closeNetServer(server);
    }
  });

  it("accepts an attachable target returned by /json/list", async () => {
    let requestedPath: string | undefined;
    const server = createHttpServer((request, response) => {
      requestedPath = request.url;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([
        { webSocketDebuggerUrl: "ws://127.0.0.1:9229/target-id" },
      ]));
    });
    const port = await listenHttpServer(server);
    try {
      await expect(probeInspectorReady(port, 500)).resolves.toEqual({ status: "ready" });
      expect(requestedPath).toBe("/json/list");
    } finally {
      await closeHttpServer(server);
    }
  });

  it.each([
    ["an empty target array", "[]"],
    ["a non-array payload", "{}"],
    ["a target without a WebSocket URL", "[{}]"],
    ["a malformed WebSocket URL", '[{"webSocketDebuggerUrl":"not a URL"}]'],
    ["a non-WebSocket URL", '[{"webSocketDebuggerUrl":"http://127.0.0.1:9229/id"}]'],
  ])("rejects %s", async (_description, body) => {
    await expect(probeJsonBody(body)).resolves.toBe("unreachable");
  });

  it("bounds an inspector attempt when the HTTP server hangs", async () => {
    const server = createHttpServer(() => {
      // Deliberately never answer the request.
    });
    const port = await listenHttpServer(server);
    const startedAt = Date.now();
    try {
      await expect(probeInspectorReady(port, 150)).resolves.toEqual({
        status: "unreachable",
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await closeHttpServer(server);
    }
  });

  it("uses an absolute attempt deadline even when the server trickles data", async () => {
    const timers = new Set<NodeJS.Timeout>();
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      const timer = setInterval(() => {
        response.write(" ");
      }, 20);
      timers.add(timer);
      response.once("close", () => {
        clearInterval(timer);
        timers.delete(timer);
      });
    });
    const port = await listenHttpServer(server);
    const startedAt = Date.now();
    try {
      await expect(probeInspectorReady(port, 150)).resolves.toEqual({
        status: "unreachable",
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      for (const timer of timers) {
        clearInterval(timer);
      }
      await closeHttpServer(server);
    }
  });

  it("stops an active HTTP probe promptly when the caller aborts", async () => {
    const server = createHttpServer(() => {
      // Keep the request open so cancellation must destroy the socket.
    });
    const port = await listenHttpServer(server);
    const controller = new AbortController();
    const startedAt = Date.now();
    const probing = probeInspectorReady(port, 60_000, controller.signal);
    controller.abort();
    try {
      await expect(probing).rejects.toMatchObject({ code: "ABORTED" });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await closeHttpServer(server);
    }
  });
});

describe("Windows netstat parsing", () => {
  const output = [
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:20000          0.0.0.0:0              LISTENING       90",
    "  TCP    127.0.0.1:2000         0.0.0.0:0              LISTENING       50",
    "  TCP    [::]:2000              [::]:0                 LISTENING       30",
    "  TCP    127.0.0.1:2000         127.0.0.1:4000         ESTABLISHED     70",
    "  UDP    0.0.0.0:2000           *:*                                    80",
  ].join("\r\n");

  it("matches the numeric local port instead of a substring", () => {
    expect(parseWindowsNetstatListeningPids(output, 2_000)).toEqual([30, 50]);
    expect(parseWindowsNetstatListeningPids(output, 20_000)).toEqual([90]);
  });

  it("returns PIDs in deterministic order", () => {
    const duplicate = `${output}\r\n  TCP    0.0.0.0:2000  0.0.0.0:0  LISTENING  30`;
    expect(parseWindowsNetstatListeningPids(duplicate, 2_000)).toEqual([30, 50]);
  });
});

describe("listener ownership", () => {
  let server: NetServer | undefined;

  afterEach(async () => {
    if (server) {
      await closeNetServer(server);
      server = undefined;
    }
  });

  it("cancels ownership inspection before starting platform commands", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(inspectPortOwnership(21_994, process.pid, controller.signal))
      .rejects.toMatchObject({ code: "ABORTED" });
  });

  it("reports all listener PIDs and verifies membership", async () => {
    server = createNetServer();
    const port = await listenNetServer(server);

    await expect(findListeningProcessIds(port)).resolves.toEqual([process.pid]);
    await expect(inspectPortOwnership(port, process.pid)).resolves.toEqual({
      status: "owned",
      pids: [process.pid],
    });
    await expect(inspectPortOwnership(port, process.pid + 1)).resolves.toEqual({
      status: "not-owned",
      pids: [process.pid],
    });
  });

  it("accepts the expected owner even when it is not the first listener PID", () => {
    expect(classifyPortOwnership([40_001, 40_002], 40_002)).toEqual({
      status: "owned",
      pids: [40_001, 40_002],
    });
  });

  it("keeps the single-PID compatibility accessor deterministic", async () => {
    server = createNetServer();
    const port = await listenNetServer(server);
    await expect(findListeningProcessId(port)).resolves.toBe(process.pid);
  });

  it("reports no owner when no process is listening", async () => {
    const port = await reserveFreePort();
    await expect(findListeningProcessId(port)).resolves.toBeUndefined();
    await expect(inspectPortOwnership(port, process.pid)).resolves.toEqual({
      status: "not-listening",
      pids: [],
    });
  });

  it("reports an actionable unverified result when Darwin has no lsof", async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), "cf-debugger-no-lsof-"));
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("PATH", emptyPath);

    try {
      await expect(inspectListeningProcesses(21_993)).resolves.toEqual({
        status: "unverified",
        reason: expect.stringMatching(/lsof command is required/i),
      });
    } finally {
      vi.unstubAllEnvs();
      platform.mockRestore();
      await rm(emptyPath, { recursive: true, force: true });
    }
  });
});
