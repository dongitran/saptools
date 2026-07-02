import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as paths from "../../src/paths.js";
import {
  matchesKey,
  readActiveSessions,
  readSessionSnapshot,
  registerNewSession,
  removeSession,
  sessionKeyString,
  updateSessionPid,
  updateSessionStatus,
} from "../../src/state.js";

async function listenOnEphemeralPort(): Promise<{ readonly server: Server; readonly port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected TCP server address");
  }
  return { server, port: address.port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

describe("state management", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cf-debugger-state-"));
    vi.spyOn(paths, "stateFilePath").mockReturnValue(join(tempDir, "state.json"));
    vi.spyOn(paths, "stateLockPath").mockReturnValue(join(tempDir, "state.lock"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("sessionKeyString formats region:org:space:app", () => {
    expect(
      sessionKeyString({ region: "eu10", org: "org-a", space: "dev", app: "demo-app" }),
    ).toBe("eu10:org-a:dev:demo-app");
  });

  it("matchesKey returns true only for identical keys", () => {
    const key = { region: "eu10", org: "org-a", space: "dev", app: "demo-app" };
    expect(matchesKey(key, key)).toBe(true);
    expect(matchesKey(key, { ...key, app: "other-app" })).toBe(false);
  });

  it("registers a new session and makes it listable", async () => {
    const result = await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      portProbe: async () => true,
      cfHomeForSession: (id) => join(tempDir, id),
    });
    expect(result.existing).toBeUndefined();
    expect(result.session.localPort).toBeGreaterThanOrEqual(20_000);

    const sessions = await readActiveSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.app).toBe("demo-app");
  });

  it("returns existing session when the same key is re-registered", async () => {
    const first = await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      portProbe: async () => true,
      cfHomeForSession: (id) => join(tempDir, id),
    });
    const second = await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      portProbe: async () => true,
      cfHomeForSession: (id) => join(tempDir, id),
    });
    expect(second.existing?.sessionId).toBe(first.session.sessionId);
  });

  it("assigns non-conflicting ports for different sessions", async () => {
    const a = await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app-a",
      apiEndpoint: "https://example.com",
      portProbe: async () => true,
      cfHomeForSession: (id) => join(tempDir, id),
    });
    const b = await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app-b",
      apiEndpoint: "https://example.com",
      portProbe: async () => true,
      cfHomeForSession: (id) => join(tempDir, id),
    });
    expect(a.session.localPort).not.toBe(b.session.localPort);
  });

  it("uses a free preferred port when provided", async () => {
    const result = await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      preferredPort: 20_555,
      portProbe: async () => true,
      cfHomeForSession: (id) => join(tempDir, id),
    });

    expect(result.session.localPort).toBe(20_555);
  });

  it("skips an unavailable preferred port and selects the first free fallback", async () => {
    const result = await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      preferredPort: 20_555,
      portProbe: async (port) => port !== 20_555,
      cfHomeForSession: (id) => join(tempDir, id),
    });

    expect(result.session.localPort).toBe(20_000);
  });

  it("throws when no local port can be reserved", async () => {
    await expect(
      registerNewSession({
        region: "eu10",
        org: "org-a",
        space: "dev",
        app: "demo-app",
        apiEndpoint: "https://example.com",
        portProbe: async () => false,
        cfHomeForSession: (id) => join(tempDir, id),
        basePort: 30_000,
        maxPort: 30_001,
      }),
    ).rejects.toMatchObject({
      code: "PORT_UNAVAILABLE",
    });
  });

  it("updateSessionStatus writes the new status to disk", async () => {
    const result = await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      portProbe: async () => true,
      cfHomeForSession: (id) => join(tempDir, id),
    });
    await updateSessionStatus(result.session.sessionId, "ready");
    const sessions = await readSessionSnapshot();
    expect(sessions[0]?.status).toBe("ready");
  });

  it("updateSessionStatus stores and clears optional status messages", async () => {
    const result = await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      portProbe: async () => true,
      cfHomeForSession: (id) => join(tempDir, id),
    });

    await updateSessionStatus(result.session.sessionId, "ssh-enabling", "waiting");
    expect((await readActiveSessions())[0]?.message).toBe("waiting");

    await updateSessionStatus(result.session.sessionId, "ready");
    expect((await readActiveSessions())[0]?.message).toBeUndefined();
  });

  it("updateSessionStatus returns undefined for a missing session", async () => {
    await expect(updateSessionStatus("missing", "ready")).resolves.toBeUndefined();
  });

  it("updateSessionPid writes the new pid to disk", async () => {
    const result = await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      portProbe: async () => true,
      cfHomeForSession: (id) => join(tempDir, id),
    });
    await updateSessionPid(result.session.sessionId, process.pid);
    const sessions = await readActiveSessions();
    expect(sessions[0]?.pid).toBe(process.pid);
  });

  it("updateSessionPid returns undefined for a missing session", async () => {
    await expect(updateSessionPid("missing", process.pid)).resolves.toBeUndefined();
  });

  it("removeSession deletes the entry", async () => {
    const result = await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      portProbe: async () => true,
      cfHomeForSession: (id) => join(tempDir, id),
    });
    await removeSession(result.session.sessionId);
    expect(await readActiveSessions()).toEqual([]);
  });

  it("removeSession returns undefined for a missing session", async () => {
    await expect(removeSession("missing")).resolves.toBeUndefined();
  });

  it("resets invalid state files to an empty state", async () => {
    await writeFile(join(tempDir, "state.json"), "{not json", "utf8");

    await expect(readActiveSessions()).resolves.toEqual([]);
  });

  it("prunes sessions whose pid is dead on the current host", async () => {
    const stateFile = join(tempDir, "state.json");
    await writeFile(
      stateFile,
      JSON.stringify({
        version: "1",
        sessions: [
          {
            sessionId: "stale",
            pid: 1,
            hostname: hostname(),
            region: "eu10",
            org: "org-a",
            space: "dev",
            app: "demo-app",
            apiEndpoint: "https://example.com",
            localPort: 20_000,
            remotePort: 9229,
            cfHomeDir: join(tempDir, "home"),
            startedAt: new Date().toISOString(),
            status: "ready",
          },
        ],
      }),
      "utf8",
    );
    // PID 1 is init — always alive. We need a definitely-dead pid instead.
    const definitelyDead = 2_147_483_600;
    const modified = JSON.parse(await readFile(stateFile, "utf8")) as {
      sessions: { pid: number }[];
    };
    modified.sessions[0]!.pid = definitelyDead;
    await writeFile(stateFile, JSON.stringify(modified), "utf8");

    const sessions = await readActiveSessions();
    expect(sessions).toEqual([]);
  });

  it("reads a snapshot without pruning sessions whose pid is dead on the current host", async () => {
    const stateFile = join(tempDir, "state.json");
    const definitelyDead = 2_147_483_600;
    await writeFile(
      stateFile,
      JSON.stringify({
        version: "1",
        sessions: [
          {
            sessionId: "stale",
            pid: definitelyDead,
            hostname: hostname(),
            region: "eu10",
            org: "org-a",
            space: "dev",
            app: "demo-app",
            apiEndpoint: "https://example.com",
            localPort: 20_000,
            remotePort: 9229,
            cfHomeDir: join(tempDir, "home"),
            startedAt: new Date().toISOString(),
            status: "ready",
          },
        ],
      }),
      "utf8",
    );

    const sessions = await readSessionSnapshot();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe("stale");
  });

  it("keeps remote-host sessions even when their pid is not local", async () => {
    const stateFile = join(tempDir, "state.json");
    await writeFile(
      stateFile,
      JSON.stringify({
        version: "1",
        sessions: [
          {
            sessionId: "remote",
            pid: 2_147_483_600,
            hostname: "another-host",
            region: "eu10",
            org: "org-a",
            space: "dev",
            app: "demo-app",
            apiEndpoint: "https://example.com",
            localPort: 20_000,
            remotePort: 9229,
            cfHomeDir: join(tempDir, "home"),
            startedAt: new Date().toISOString(),
            status: "ready",
          },
        ],
      }),
      "utf8",
    );

    const sessions = await readActiveSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe("remote");
  });

  it("prunes ready sessions on the current host when their local port is not listening", async () => {
    const stateFile = join(tempDir, "state.json");
    const { server, port } = await listenOnEphemeralPort();
    await closeServer(server);

    await writeFile(
      stateFile,
      JSON.stringify({
        version: "1",
        sessions: [
          {
            sessionId: "stale-port",
            pid: process.pid,
            hostname: hostname(),
            region: "eu10",
            org: "org-a",
            space: "dev",
            app: "demo-app",
            apiEndpoint: "https://example.com",
            localPort: port,
            remotePort: 9229,
            cfHomeDir: join(tempDir, "home"),
            startedAt: new Date().toISOString(),
            status: "ready",
          },
        ],
      }),
      "utf8",
    );

    await expect(readActiveSessions()).resolves.toEqual([]);
    const raw = JSON.parse(await readFile(stateFile, "utf8")) as { sessions: unknown[] };
    expect(raw.sessions).toEqual([]);
  });

  it("keeps ready sessions on the current host when pid is alive and local port is listening", async () => {
    const { server, port } = await listenOnEphemeralPort();
    try {
      await writeFile(
        join(tempDir, "state.json"),
        JSON.stringify({
          version: "1",
          sessions: [
            {
              sessionId: "healthy",
              pid: process.pid,
              hostname: hostname(),
              region: "eu10",
              org: "org-a",
              space: "dev",
              app: "demo-app",
              apiEndpoint: "https://example.com",
              localPort: port,
              remotePort: 9229,
              cfHomeDir: join(tempDir, "home"),
              startedAt: new Date().toISOString(),
              status: "ready",
            },
          ],
        }),
        "utf8",
      );

      const sessions = await readActiveSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe("healthy");
    } finally {
      await closeServer(server);
    }
  });

  it("prunes ready sessions when the listening port belongs to a different known pid", async () => {
    const { server, port } = await listenOnEphemeralPort();
    try {
      await writeFile(
        join(tempDir, "state.json"),
        JSON.stringify({
          version: "1",
          sessions: [
            {
              sessionId: "wrong-owner",
              pid: 1,
              hostname: hostname(),
              region: "eu10",
              org: "org-a",
              space: "dev",
              app: "demo-app",
              apiEndpoint: "https://example.com",
              localPort: port,
              remotePort: 9229,
              cfHomeDir: join(tempDir, "home"),
              startedAt: new Date().toISOString(),
              status: "ready",
            },
          ],
        }),
        "utf8",
      );

      await expect(readActiveSessions()).resolves.toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it("returns existing for a same-key ready session whose local port is listening", async () => {
    const { server, port } = await listenOnEphemeralPort();
    try {
      await writeFile(
        join(tempDir, "state.json"),
        JSON.stringify({
          version: "1",
          sessions: [
            {
              sessionId: "healthy-duplicate",
              pid: process.pid,
              hostname: hostname(),
              region: "eu10",
              org: "org-a",
              space: "dev",
              app: "demo-app",
              apiEndpoint: "https://example.com",
              localPort: port,
              remotePort: 9229,
              cfHomeDir: join(tempDir, "old-home"),
              startedAt: new Date().toISOString(),
              status: "ready",
            },
          ],
        }),
        "utf8",
      );

      const result = await registerNewSession({
        region: "eu10",
        org: "org-a",
        space: "dev",
        app: "demo-app",
        apiEndpoint: "https://example.com",
        portProbe: async () => true,
        cfHomeForSession: (id) => join(tempDir, id),
      });

      expect(result.existing?.sessionId).toBe("healthy-duplicate");
      expect(result.session.localPort).toBe(port);
    } finally {
      await closeServer(server);
    }
  });

  it("allows registration to replace stale same-key sessions whose pid is dead", async () => {
    await writeFile(
      join(tempDir, "state.json"),
      JSON.stringify({
        version: "1",
        sessions: [
          {
            sessionId: "dead-duplicate",
            pid: 2_147_483_600,
            hostname: hostname(),
            region: "eu10",
            org: "org-a",
            space: "dev",
            app: "demo-app",
            apiEndpoint: "https://example.com",
            localPort: 30_124,
            remotePort: 9229,
            cfHomeDir: join(tempDir, "old-home"),
            startedAt: new Date().toISOString(),
            status: "ready",
          },
        ],
      }),
      "utf8",
    );

    const result = await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      preferredPort: 30_124,
      portProbe: async () => true,
      cfHomeForSession: (id) => join(tempDir, id),
    });

    expect(result.existing).toBeUndefined();
    expect(result.session.sessionId).not.toBe("dead-duplicate");
    expect(result.session.localPort).toBe(30_124);
  });

  it("allows registration to replace stale same-key sessions and reuse an available port", async () => {
    await writeFile(
      join(tempDir, "state.json"),
      JSON.stringify({
        version: "1",
        sessions: [
          {
            sessionId: "stale-duplicate",
            pid: process.pid,
            hostname: hostname(),
            region: "eu10",
            org: "org-a",
            space: "dev",
            app: "demo-app",
            apiEndpoint: "https://example.com",
            localPort: 30_123,
            remotePort: 9229,
            cfHomeDir: join(tempDir, "old-home"),
            startedAt: new Date().toISOString(),
            status: "ready",
          },
        ],
      }),
      "utf8",
    );

    const result = await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      preferredPort: 30_123,
      portProbe: async () => true,
      cfHomeForSession: (id) => join(tempDir, id),
    });

    expect(result.existing).toBeUndefined();
    expect(result.session.sessionId).not.toBe("stale-duplicate");
    expect(result.session.localPort).toBe(30_123);
  });

});
