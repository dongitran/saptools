import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as paths from "../../src/paths.js";
import {
  isPidOrGroupAlive,
  matchesKey,
  readActiveSessions,
  readSessionSnapshot,
  registerNewSession,
  removeSession,
  requestSessionStop,
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

function persistedSession(
  tempDir: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const session: Readonly<Record<string, unknown>> = {
    sessionId: "session-a",
    pid: process.pid,
    controllerPid: process.pid,
    hostname: hostname(),
    region: "eu10",
    org: "org-a",
    space: "dev",
    app: "demo-app",
    process: "web",
    instance: 0,
    apiEndpoint: "https://example.com",
    localPort: 20_111,
    remotePort: 9229,
    cfHomeDir: join(tempDir, "session-a"),
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "starting",
    ...overrides,
  };
  return session["status"] === "ready" && session["tunnelPid"] === undefined
    ? { ...session, tunnelPid: session["pid"] }
    : session;
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

  it.runIf(process.platform !== "win32")(
    "detects a live process group after its leader PID exits",
    () => {
      const processGroupId = 44_001;
      const killSpy = vi.spyOn(process, "kill").mockImplementation((pid: number) => {
        if (pid === -processGroupId) {
          return true;
        }
        throw Object.assign(new Error("process missing"), { code: "ESRCH" });
      });

      expect(isPidOrGroupAlive(processGroupId)).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(processGroupId, 0);
      expect(killSpy).toHaveBeenCalledWith(-processGroupId, 0);
    },
  );

  it("sessionKeyString formats region:org:space:app", () => {
    expect(
      sessionKeyString({ region: "eu10", org: "org-a", space: "dev", app: "demo-app" }),
    ).toBe("eu10:org-a:dev:demo-app");
    expect(
      sessionKeyString({
        region: "eu10",
        org: "org-a",
        space: "dev",
        app: "demo-app",
        process: "worker",
        instance: 2,
      }),
    ).toBe("eu10:org-a:dev:demo-app:worker:2");
  });

  it("matchesKey returns true only for identical keys", () => {
    const key = { region: "eu10", org: "org-a", space: "dev", app: "demo-app" };
    expect(matchesKey(key, key)).toBe(true);
    expect(matchesKey(key, { ...key, app: "other-app" })).toBe(false);
    expect(matchesKey(key, { ...key, process: "web", instance: 0 })).toBe(true);
    expect(matchesKey(
      { ...key, process: "worker", instance: 0 },
      { ...key, process: "web", instance: 0 },
    )).toBe(false);
  });

  it("rejects a v1 state payload placed in the isolated v2 namespace", async () => {
    await writeFile(
      join(tempDir, "state.json"),
      JSON.stringify({
        version: "1",
        sessions: [persistedSession(tempDir)],
      }),
      "utf8",
    );

    await expect(readSessionSnapshot()).resolves.toEqual([]);
  });

  it("persists new sessions with the v2 schema identity", async () => {
    await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      portProbe: async () => true,
      cfHomeForSession: (id) => join(tempDir, id),
    });

    const raw = JSON.parse(await readFile(join(tempDir, "state.json"), "utf8")) as {
      readonly version?: unknown;
    };
    expect(raw.version).toBe("2");
  });

  it.each([
    ["unsafe session id", { sessionId: "../../outside" }],
    ["non-numeric pid", { pid: "123" }],
    ["invalid status", { status: "unknown" }],
    ["relative CF home", { cfHomeDir: "relative/home" }],
    ["invalid optional Node pid", { remoteNodePid: -1 }],
    ["missing process identity", { process: undefined }],
    ["missing instance identity", { instance: undefined }],
    ["missing controller pid", { controllerPid: undefined }],
    ["inconsistent tunnel pid", { status: "ready", tunnelPid: 1234 }],
  ])("rejects a persisted session with %s", async (_label, overrides): Promise<void> => {
    await writeFile(
      join(tempDir, "state.json"),
      JSON.stringify({
        version: "2",
        sessions: [persistedSession(tempDir, overrides)],
      }),
      "utf8",
    );

    await expect(readSessionSnapshot()).resolves.toEqual([]);
  });

  it("rejects duplicate persisted session ids", async () => {
    await writeFile(
      join(tempDir, "state.json"),
      JSON.stringify({
        version: "2",
        sessions: [
          persistedSession(tempDir),
          persistedSession(tempDir, { app: "another-app" }),
        ],
      }),
      "utf8",
    );

    await expect(readSessionSnapshot()).resolves.toEqual([]);
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

  it("rejects an unsafe generated session id before persisting it", async () => {
    await expect(registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      portProbe: async () => true,
      sessionIdFactory: () => "../../outside",
      cfHomeForSession: (id) => join(tempDir, id),
    })).rejects.toMatchObject({ code: "UNSAFE_INPUT" });

    await expect(readSessionSnapshot()).resolves.toEqual([]);
  });

  it("writes private state and hardens legacy parent permissions", async () => {
    await chmod(tempDir, 0o755);

    await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      portProbe: async () => true,
      cfHomeForSession: (id) => join(tempDir, id),
    });

    expect((await stat(tempDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(tempDir, "state.json"))).mode & 0o777).toBe(0o600);
  });

  it("hardens permissions on a valid v2 state file while reading", async () => {
    const statePath = join(tempDir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({ version: "2", sessions: [persistedSession(tempDir)] }),
      "utf8",
    );
    await chmod(statePath, 0o644);
    await chmod(tempDir, 0o755);

    await expect(readSessionSnapshot()).resolves.toHaveLength(1);

    expect((await stat(tempDir)).mode & 0o777).toBe(0o700);
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
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

  it("allows the same app to register distinct process instances", async () => {
    const base = {
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      process: "web",
      apiEndpoint: "https://example.com",
      portProbe: async () => true,
      cfHomeForSession: (id: string) => join(tempDir, id),
    };
    const first = await registerNewSession({ ...base, instance: 0 });
    const second = await registerNewSession({ ...base, instance: 1 });

    expect(first.existing).toBeUndefined();
    expect(second.existing).toBeUndefined();
    expect(second.session.localPort).not.toBe(first.session.localPort);
  });

  it("keeps API endpoint but not requested Node PID in registration identity", async () => {
    const base = {
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      process: "web",
      instance: 0,
      portProbe: async () => true,
      cfHomeForSession: (id: string) => join(tempDir, id),
    };
    const first = await registerNewSession({
      ...base,
      apiEndpoint: "https://api-a.example.com",
      nodePid: 101,
    });
    const otherEndpoint = await registerNewSession({
      ...base,
      apiEndpoint: "https://api-b.example.com",
      nodePid: 101,
    });
    const otherNode = await registerNewSession({
      ...base,
      apiEndpoint: "https://api-a.example.com",
      nodePid: 202,
    });

    expect(first.existing).toBeUndefined();
    expect(otherEndpoint.existing).toBeUndefined();
    expect(otherNode.existing?.sessionId).toBe(first.session.sessionId);
    expect(new Set([
      first.session.localPort,
      otherEndpoint.session.localPort,
      otherNode.session.localPort,
    ]).size).toBe(2);
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
    await updateSessionPid(result.session.sessionId, process.pid);
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

    await updateSessionPid(result.session.sessionId, process.pid);
    await updateSessionStatus(result.session.sessionId, "ready");
    expect((await readActiveSessions())[0]?.message).toBeUndefined();
  });

  it("updateSessionStatus returns undefined for a missing session", async () => {
    await expect(updateSessionStatus("missing", "ready")).resolves.toBeUndefined();
  });

  it("does not let startup mutations overwrite a stopping session", async () => {
    const result = await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      portProbe: async () => true,
      cfHomeForSession: (id) => join(tempDir, id),
    });
    const { updateSessionRemoteNodePid } = await import("../../src/state.js");

    await updateSessionStatus(result.session.sessionId, "stopping", "Stop requested");
    await updateSessionRemoteNodePid(result.session.sessionId, 4312);
    await updateSessionPid(result.session.sessionId, 99_999);
    await updateSessionStatus(result.session.sessionId, "ready");

    expect((await readSessionSnapshot())[0]).toEqual(expect.objectContaining({
      pid: result.session.pid,
      status: "stopping",
      message: "Stop requested",
    }));
    expect((await readSessionSnapshot())[0]?.remoteNodePid).toBeUndefined();
  });

  it("records an idempotent stop intent without overwriting the startup phase", async () => {
    const result = await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      portProbe: async () => true,
      cfHomeForSession: (id) => join(tempDir, id),
    });
    await updateSessionStatus(result.session.sessionId, "signaling");

    const first = await requestSessionStop(result.session.sessionId);
    const second = await requestSessionStop(result.session.sessionId);

    expect(first?.previousStatus).toBe("signaling");
    expect(first?.session.status).toBe("signaling");
    expect(first?.session.stopRequestedAt).toEqual(expect.any(String));
    expect(second?.session.stopRequestedAt).toBe(first?.session.stopRequestedAt);
  });

  it("rejects a ready transition before a tunnel PID exists", async () => {
    const result = await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      portProbe: async () => true,
      cfHomeForSession: (id) => join(tempDir, id),
    });

    await expect(updateSessionStatus(result.session.sessionId, "ready")).rejects.toMatchObject({
      code: "SESSION_STATE_CONFLICT",
    });
    expect((await readSessionSnapshot())[0]?.status).toBe("starting");
  });

  it("rejects an invalid tunnel PID without poisoning persisted state", async () => {
    const result = await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      portProbe: async () => true,
      cfHomeForSession: (id) => join(tempDir, id),
    });

    await expect(updateSessionPid(result.session.sessionId, 0)).rejects.toMatchObject({
      code: "UNSAFE_INPUT",
    });
    await expect(readSessionSnapshot()).resolves.toHaveLength(1);
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

  it("preserves process targeting and remote Node PID through every updater", async () => {
    const result = await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      process: "worker",
      instance: 2,
      apiEndpoint: "https://example.com",
      portProbe: async () => true,
      cfHomeForSession: (id) => join(tempDir, id),
    });
    const { updateSessionRemoteNodePid } = await import("../../src/state.js");

    await updateSessionRemoteNodePid(result.session.sessionId, 4312);
    await updateSessionStatus(result.session.sessionId, "signaling", "selected");
    await updateSessionPid(result.session.sessionId, process.pid);

    expect((await readSessionSnapshot())[0]).toEqual(expect.objectContaining({
      process: "worker",
      instance: 2,
      remoteNodePid: 4312,
      message: "selected",
    }));
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
        version: "2",
        sessions: [persistedSession(tempDir, { pid: 1, status: "ready" })],
      }),
      "utf8",
    );
    // PID 1 is init — always alive. We need a definitely-dead pid instead.
    const definitelyDead = 2_147_483_600;
    const modified = JSON.parse(await readFile(stateFile, "utf8")) as {
      sessions: { pid: number; tunnelPid: number }[];
    };
    modified.sessions[0]!.pid = definitelyDead;
    modified.sessions[0]!.tunnelPid = definitelyDead;
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
        version: "2",
        sessions: [persistedSession(tempDir, {
          sessionId: "stale",
          pid: definitelyDead,
          status: "ready",
        })],
      }),
      "utf8",
    );

    const sessions = await readSessionSnapshot();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe("stale");
  });

  it("preserves remote-host records without exposing them as local active sessions", async () => {
    const stateFile = join(tempDir, "state.json");
    await writeFile(
      stateFile,
      JSON.stringify({
        version: "2",
        sessions: [persistedSession(tempDir, {
          sessionId: "remote",
          pid: 2_147_483_600,
          hostname: "another-host",
          status: "ready",
        })],
      }),
      "utf8",
    );

    const sessions = await readActiveSessions();
    expect(sessions).toEqual([]);
    expect((await readSessionSnapshot())[0]?.sessionId).toBe("remote");
  });

  it("preserves remote-host records while registering a local session", async () => {
    const stateFile = join(tempDir, "state.json");
    await writeFile(stateFile, JSON.stringify({
      version: "2",
      sessions: [persistedSession(tempDir, {
        sessionId: "remote",
        pid: 2_147_483_600,
        hostname: "another-host",
        app: "remote-app",
        cfHomeDir: join(tempDir, "remote-home"),
        status: "ready",
      })],
    }), "utf8");

    await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "local-app",
      apiEndpoint: "https://example.com",
      portProbe: async () => true,
      cfHomeForSession: (id) => join(tempDir, id),
    });

    expect((await readSessionSnapshot()).map((session) => session.sessionId)).toEqual([
      "remote",
      expect.any(String),
    ]);
  });

  it("retains an unverifiable ready session while its tunnel pid is alive", async () => {
    const stateFile = join(tempDir, "state.json");
    const { server, port } = await listenOnEphemeralPort();
    await closeServer(server);

    await writeFile(
      stateFile,
      JSON.stringify({
        version: "2",
        sessions: [persistedSession(tempDir, {
          sessionId: "stale-port",
          localPort: port,
          status: "ready",
        })],
      }),
      "utf8",
    );

    await expect(readActiveSessions()).resolves.toHaveLength(1);
    const raw = JSON.parse(await readFile(stateFile, "utf8")) as { sessions: unknown[] };
    expect(raw.sessions).toHaveLength(1);
  });

  it("keeps ready sessions on the current host when pid is alive and local port is listening", async () => {
    const { server, port } = await listenOnEphemeralPort();
    try {
      await writeFile(
        join(tempDir, "state.json"),
        JSON.stringify({
          version: "2",
          sessions: [persistedSession(tempDir, {
            sessionId: "healthy",
            localPort: port,
            status: "ready",
          })],
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

  it("retains ready state when a port owner mismatch requires explicit recovery", async () => {
    const { server, port } = await listenOnEphemeralPort();
    try {
      await writeFile(
        join(tempDir, "state.json"),
        JSON.stringify({
          version: "2",
          sessions: [persistedSession(tempDir, {
            sessionId: "wrong-owner",
            pid: 1,
            localPort: port,
            status: "ready",
          })],
        }),
        "utf8",
      );

      await expect(readActiveSessions()).resolves.toHaveLength(1);
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
          version: "2",
          sessions: [persistedSession(tempDir, {
            sessionId: "healthy-duplicate",
            localPort: port,
            cfHomeDir: join(tempDir, "old-home"),
            status: "ready",
          })],
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
        version: "2",
        sessions: [persistedSession(tempDir, {
          sessionId: "dead-duplicate",
          pid: 2_147_483_600,
          localPort: 30_124,
          cfHomeDir: join(tempDir, "old-home"),
          status: "ready",
        })],
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

  it("does not replace an unverifiable same-key session whose tunnel pid is alive", async () => {
    await writeFile(
      join(tempDir, "state.json"),
      JSON.stringify({
        version: "2",
        sessions: [persistedSession(tempDir, {
          sessionId: "stale-duplicate",
          localPort: 30_123,
          cfHomeDir: join(tempDir, "old-home"),
          status: "ready",
        })],
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

    expect(result.existing?.sessionId).toBe("stale-duplicate");
    expect(result.session.sessionId).toBe("stale-duplicate");
    expect(result.session.localPort).toBe(30_123);
  });

});
