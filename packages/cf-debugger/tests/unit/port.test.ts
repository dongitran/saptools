import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  findListeningProcessId,
  isPortFree,
  killProcessOnPort,
  probeTunnelReady,
} from "../../src/port.js";

async function reserveFreePort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address !== null && typeof address === "object") {
        const port = address.port;
        server.close(() => {
          resolve(port);
        });
      }
    });
  });
}

describe("isPortFree", () => {
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server?.close(() => {
          resolve();
        });
      });
      server = undefined;
    }
  });

  it("returns true when nothing is listening", async () => {
    const free = await isPortFree(21_999);
    expect(free).toBe(true);
  });

  it("returns false when a server is bound on the port", async () => {
    server = createServer();
    const port = await new Promise<number>((resolve) => {
      server?.listen(0, "127.0.0.1", () => {
        const address = server?.address();
        if (address !== null && typeof address === "object") {
          resolve(address.port);
        }
      });
    });
    const free = await isPortFree(port);
    expect(free).toBe(false);
  });
});

describe("probeTunnelReady", () => {
  it("returns true when the port becomes connectable within the timeout", async () => {
    const server = createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address !== null && typeof address === "object") {
          resolve(address.port);
        }
      });
    });
    try {
      const ready = await probeTunnelReady(port, 2_000);
      expect(ready).toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it("returns false when no server ever comes up", async () => {
    const ready = await probeTunnelReady(21_998, 600);
    expect(ready).toBe(false);
  });

  it("returns true when the port becomes connectable after polling starts", async () => {
    const port = await reserveFreePort();
    let server: ReturnType<typeof createServer> | undefined;
    const timer = setTimeout(() => {
      server = createServer();
      server.listen(port, "127.0.0.1");
    }, 100);

    try {
      await expect(probeTunnelReady(port, 2_000)).resolves.toBe(true);
    } finally {
      clearTimeout(timer);
      if (server) {
        await new Promise<void>((resolve) => {
          server?.close(() => {
            resolve();
          });
        });
      }
    }
  });

  it("returns false when the timeout elapses before polling can connect", async () => {
    const port = await reserveFreePort();
    await expect(probeTunnelReady(port, 1)).resolves.toBe(false);
  });
});

describe("findListeningProcessId", () => {
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server?.close(() => {
          resolve();
        });
      });
      server = undefined;
    }
  });

  it("returns the current process pid for a live listener", async () => {
    server = createServer();
    const port = await new Promise<number>((resolve) => {
      server?.listen(0, "127.0.0.1", () => {
        const address = server?.address();
        if (address !== null && typeof address === "object") {
          resolve(address.port);
        }
      });
    });

    const pid = await findListeningProcessId(port);
    expect(pid).toBe(process.pid);
  });

  it("returns undefined when no process is listening", async () => {
    const pid = await findListeningProcessId(21_997);
    expect(pid).toBeUndefined();
  });
});

describe("killProcessOnPort", () => {
  it("does nothing when no process is listening on the port", async () => {
    const port = await reserveFreePort();
    await expect(killProcessOnPort(port)).resolves.toBeUndefined();
  });
});
