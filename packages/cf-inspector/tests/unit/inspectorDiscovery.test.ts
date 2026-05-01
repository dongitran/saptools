import { createServer } from "node:http";
import type { Server } from "node:http";

import { describe, expect, it } from "vitest";

import {
  discoverInspectorTargets,
  fetchInspectorVersion,
} from "../../src/inspector/discovery.js";

interface RouteResponse {
  readonly statusCode?: number;
  readonly body: string;
}

interface TestEndpoint {
  readonly host: string;
  readonly port: number;
}

function jsonResponse(value: unknown): RouteResponse {
  return { body: JSON.stringify(value) };
}

async function listenServer(server: Server): Promise<TestEndpoint> {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("test server did not bind to a TCP address");
  }
  return { host: "127.0.0.1", port: address.port };
}

async function withServer(
  routes: Readonly<Record<string, RouteResponse>>,
  run: (endpoint: TestEndpoint) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    const route = routes[req.url ?? ""];
    if (route === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(route.statusCode ?? 200, { "content-type": "application/json" });
    res.end(route.body);
  });
  try {
    await run(await listenServer(server));
  } finally {
    await closeServer(server);
  }
}

async function withHangingServer(run: (endpoint: TestEndpoint) => Promise<void>): Promise<void> {
  const server = createServer(() => {
    // Leave the response open so the client-side timeout path is exercised.
  });
  try {
    await run(await listenServer(server));
  } finally {
    await closeServer(server);
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err === undefined) {
        resolve();
        return;
      }
      reject(err);
    });
  });
}

async function reserveClosedPort(): Promise<number> {
  const server = createServer();
  const { port } = await listenServer(server);
  await closeServer(server);
  return port;
}

describe("discoverInspectorTargets", () => {
  it("maps valid inspector targets and preserves optional URLs", async () => {
    await withServer(
      {
        "/json/list": jsonResponse([
          {
            description: "runtime process",
            devtoolsFrontendUrl: "/devtools/inspector.html?ws=127.0.0.1",
            faviconUrl: "https://example.test/icon.png",
            id: "target-1",
            title: "worker",
            type: "node",
            url: "file:///workspace/app.js",
            webSocketDebuggerUrl: "ws://127.0.0.1:9229/session-1",
          },
        ]),
      },
      async ({ host, port }) => {
        const targets = await discoverInspectorTargets(host, port, 500);
        expect(targets).toHaveLength(1);
        expect(targets[0]).toEqual({
          description: "runtime process",
          devtoolsFrontendUrl: "/devtools/inspector.html?ws=127.0.0.1",
          faviconUrl: "https://example.test/icon.png",
          id: "target-1",
          title: "worker",
          type: "node",
          url: "file:///workspace/app.js",
          webSocketDebuggerUrl: "ws://127.0.0.1:9229/session-1",
        });
      },
    );
  });

  it("rejects an empty target list with the discovery error code", async () => {
    await withServer(
      { "/json/list": jsonResponse([]) },
      async ({ host, port }) => {
        await expect(discoverInspectorTargets(host, port, 500)).rejects.toMatchObject({
          code: "INSPECTOR_DISCOVERY_FAILED",
          message: expect.stringContaining("No inspector targets returned"),
        });
      },
    );
  });

  it("rejects non-object target entries", async () => {
    await withServer(
      { "/json/list": jsonResponse(["target-id"]) },
      async ({ host, port }) => {
        await expect(discoverInspectorTargets(host, port, 500)).rejects.toMatchObject({
          code: "INSPECTOR_DISCOVERY_FAILED",
          message: expect.stringContaining("Inspector target is not an object"),
        });
      },
    );
  });

  it("rejects targets that omit the websocket debugger URL", async () => {
    await withServer(
      { "/json/list": jsonResponse([{ id: "target-1", type: "node" }]) },
      async ({ host, port }) => {
        await expect(discoverInspectorTargets(host, port, 500)).rejects.toMatchObject({
          code: "INSPECTOR_DISCOVERY_FAILED",
          message: expect.stringContaining("missing webSocketDebuggerUrl"),
        });
      },
    );
  });

  it("defaults missing non-required target strings to empty strings", async () => {
    await withServer(
      { "/json/list": jsonResponse([{ webSocketDebuggerUrl: "ws://127.0.0.1:9229/session-1" }]) },
      async ({ host, port }) => {
        const targets = await discoverInspectorTargets(host, port, 500);
        expect(targets[0]).toEqual({
          description: "",
          id: "",
          title: "",
          type: "",
          url: "",
          webSocketDebuggerUrl: "ws://127.0.0.1:9229/session-1",
        });
      },
    );
  });
});

describe("fetchInspectorVersion", () => {
  it("reads the canonical version fields", async () => {
    await withServer(
      {
        "/json/version": jsonResponse({
          Browser: "node.js/v20.0.0",
          "Protocol-Version": "1.3",
        }),
      },
      async ({ host, port }) => {
        await expect(fetchInspectorVersion(host, port, 500)).resolves.toEqual({
          browser: "node.js/v20.0.0",
          protocolVersion: "1.3",
        });
      },
    );
  });

  it("accepts lowercase and camelCase version fields", async () => {
    await withServer(
      {
        "/json/version": jsonResponse({
          browser: "runtime/v1",
          protocolVersion: "1.2",
        }),
      },
      async ({ host, port }) => {
        await expect(fetchInspectorVersion(host, port, 500)).resolves.toEqual({
          browser: "runtime/v1",
          protocolVersion: "1.2",
        });
      },
    );
  });

  it("rejects version responses without required fields", async () => {
    await withServer(
      { "/json/version": jsonResponse({ Browser: "runtime/v1" }) },
      async ({ host, port }) => {
        await expect(fetchInspectorVersion(host, port, 500)).rejects.toMatchObject({
          code: "INSPECTOR_DISCOVERY_FAILED",
          message: expect.stringContaining("Unexpected /json/version response"),
        });
      },
    );
  });

  it("rejects non-object version responses", async () => {
    await withServer(
      { "/json/version": jsonResponse("runtime/v1") },
      async ({ host, port }) => {
        await expect(fetchInspectorVersion(host, port, 500)).rejects.toMatchObject({
          code: "INSPECTOR_DISCOVERY_FAILED",
          message: expect.stringContaining("Unexpected /json/version response"),
        });
      },
    );
  });

  it("rejects malformed JSON with the discovery error code", async () => {
    await withServer(
      { "/json/version": { body: "{" } },
      async ({ host, port }) => {
        await expect(fetchInspectorVersion(host, port, 500)).rejects.toMatchObject({
          code: "INSPECTOR_DISCOVERY_FAILED",
          message: expect.stringContaining("Failed to parse inspector discovery response"),
        });
      },
    );
  });

  it("wraps request failures with the discovery error code", async () => {
    const port = await reserveClosedPort();
    await expect(fetchInspectorVersion("127.0.0.1", port, 500)).rejects.toMatchObject({
      code: "INSPECTOR_DISCOVERY_FAILED",
      message: expect.stringContaining("Inspector discovery at"),
    });
  });

  it("rejects stalled responses after the configured timeout", async () => {
    await withHangingServer(async ({ host, port }) => {
      await expect(fetchInspectorVersion(host, port, 20)).rejects.toMatchObject({
        code: "INSPECTOR_DISCOVERY_FAILED",
        message: expect.stringContaining("timed out after 20ms"),
      });
    });
  });
});
