import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as paths from "../../src/paths.js";
import {
  matchesKey,
  readActiveSessions,
  registerNewSession,
  removeSession,
  sessionKeyString,
  updateSessionPid,
  updateSessionStatus,
} from "../../src/state.js";

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
    const sessions = await readActiveSessions();
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
            hostname: (await import("node:os")).hostname(),
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
});
