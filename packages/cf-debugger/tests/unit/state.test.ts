import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDoctor } from "../../src/debug-session/doctor.js";
import {
  stopAllDebuggers,
  stopDebugger,
} from "../../src/debug-session/sessions.js";
import * as paths from "../../src/paths.js";
import { decodeSession } from "../../src/session-state/decoder.js";
import * as health from "../../src/session-state/health.js";
import {
  hasSessionStopIntent,
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

interface ListeningChild {
  readonly child: ChildProcess;
  readonly port: number;
}

async function spawnListeningChild(): Promise<ListeningChild> {
  const script = [
    'const net = require("node:net");',
    "const server = net.createServer((socket) => socket.end());",
    'server.listen(0, "127.0.0.1", () => {',
    "  const address = server.address();",
    '  process.stdout.write(String(address.port) + "\\n");',
    "});",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const stdout = child.stdout;
  const port = await new Promise<number>((resolve, reject) => {
    let output = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      output += chunk;
      const lineEnd = output.indexOf("\n");
      if (lineEnd < 0) {
        return;
      }
      const parsed = Number.parseInt(output.slice(0, lineEnd), 10);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        resolve(parsed);
        return;
      }
      reject(new Error("listener child returned an invalid port"));
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`listener child exited before readiness (${String(code)})`));
    });
  });
  return { child, port };
}

async function spawnSleeperChild(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });
  await once(child, "spawn");
  return child;
}

async function stopTestChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const closed = once(child, "close");
  child.kill();
  await closed;
}

function requireChildPid(child: ChildProcess): number {
  if (child.pid === undefined) {
    throw new Error("expected child PID");
  }
  return child.pid;
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
    startedAt: new Date().toISOString(),
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
    vi.spyOn(paths, "saptoolsDir").mockReturnValue(tempDir);
    vi.spyOn(paths, "sessionStopIntentPath").mockImplementation(
      (sessionId: string): string => join(tempDir, `${sessionId}.stop`),
    );
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
    const sessionWithRemotePid = decodeSession(
      persistedSession(tempDir, { remoteNodePid: 4312 }),
    );
    if (sessionWithRemotePid === undefined) {
      throw new Error("expected valid active session fixture");
    }
    expect(matchesKey(key, key)).toBe(true);
    expect(matchesKey(key, { ...key, app: "other-app" })).toBe(false);
    expect(matchesKey(key, { ...key, process: "web", instance: 0 })).toBe(true);
    expect(matchesKey(
      { ...key, process: "worker", instance: 0 },
      { ...key, process: "web", instance: 0 },
    )).toBe(false);
    expect(matchesKey(
      sessionWithRemotePid,
      { ...key, nodePid: 4312 },
    )).toBe(true);
    expect(matchesKey(
      sessionWithRemotePid,
      { ...key, nodePid: 9876 },
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

  it("decodes additive identity fields and old records without controllerPid", () => {
    const decoded = decodeSession(persistedSession(tempDir, {
      controllerPid: undefined,
      controllerProcessIdentity: "darwin:controller-start",
      tunnelProcessIdentity: "darwin:tunnel-start",
      startupTimeoutMs: 12_345,
    }));

    expect(decoded).toEqual(expect.objectContaining({
      controllerPid: process.pid,
      controllerProcessIdentity: "darwin:controller-start",
      tunnelProcessIdentity: "darwin:tunnel-start",
      startupTimeoutMs: 12_345,
    }));
  });

  it("continues to decode an empty optional status message", () => {
    expect(decodeSession(persistedSession(tempDir, { message: "" }))).toEqual(
      expect.objectContaining({ message: "" }),
    );
  });

  it("preserves the pid alias invariant while decoding additive records", () => {
    expect(decodeSession(persistedSession(tempDir, {
      status: "ready",
      pid: 41_001,
      tunnelPid: 41_002,
    }))).toBeUndefined();

    expect(decodeSession(persistedSession(tempDir, {
      controllerPid: undefined,
    }))).toEqual(expect.objectContaining({
      pid: process.pid,
      controllerPid: process.pid,
    }));
  });

  it("keeps the first duplicate session id and preserves the original state", async () => {
    const statePath = join(tempDir, "state.json");
    const original = {
      version: "2",
      sessions: [
        persistedSession(tempDir),
        persistedSession(tempDir, { app: "another-app" }),
      ],
    };
    const stderrSpy = vi.spyOn(process.stderr, "write");
    await writeFile(statePath, JSON.stringify(original), "utf8");

    await expect(readSessionSnapshot()).resolves.toEqual([
      expect.objectContaining({
        app: "demo-app",
        sessionId: "session-a",
      }),
    ]);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("session[1]: duplicate sessionId session-a"),
    );
    const files = await readdir(tempDir);
    const backup = files.find((name) => name.startsWith("state.json.corrupt-"));
    expect(backup).toEqual(expect.any(String));
    if (backup === undefined) {
      throw new Error("expected duplicate-state backup");
    }
    expect(JSON.parse(await readFile(join(tempDir, backup), "utf8"))).toEqual(original);
    const repaired = JSON.parse(await readFile(statePath, "utf8")) as {
      readonly sessions: readonly { readonly app?: unknown }[];
    };
    expect(repaired.sessions).toEqual([
      expect.objectContaining({ app: "demo-app" }),
    ]);
  });

  it("retains valid entries and preserves evidence when one entry is malformed", async () => {
    const statePath = join(tempDir, "state.json");
    const original = {
      version: "2",
      sessions: [
        persistedSession(tempDir),
        persistedSession(tempDir, { sessionId: "broken", pid: "not-a-pid" }),
        persistedSession(tempDir, {
          sessionId: "session-c",
          app: "other-app",
          cfHomeDir: join(tempDir, "session-c"),
        }),
      ],
    };
    await writeFile(statePath, JSON.stringify(original), "utf8");

    const sessions = await readSessionSnapshot();

    expect(sessions.map((session) => session.sessionId)).toEqual(["session-a", "session-c"]);
    const files = await readdir(tempDir);
    const backups = files.filter((name) => name.startsWith("state.json.corrupt-"));
    expect(backups).toHaveLength(1);
    const backup = backups[0];
    if (backup === undefined) {
      throw new Error("expected corrupt-state backup");
    }
    expect(JSON.parse(await readFile(join(tempDir, backup), "utf8"))).toEqual(original);
    const repaired = JSON.parse(await readFile(statePath, "utf8")) as {
      readonly sessions: readonly { readonly sessionId?: unknown }[];
    };
    expect(repaired.sessions.map((session) => session.sessionId)).toEqual([
      "session-a",
      "session-c",
    ]);
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

  it("starts concurrent distinct keys at different deterministic candidates", async () => {
    let firstProbeCount = 0;
    let releaseProbes: () => void = () => undefined;
    const bothProbesStarted = new Promise<void>((resolve) => {
      releaseProbes = resolve;
    });
    const probesA: number[] = [];
    const probesB: number[] = [];
    const recordProbe = (ports: number[]) => async (port: number): Promise<boolean> => {
      ports.push(port);
      if (ports.length === 1) {
        firstProbeCount += 1;
        if (firstProbeCount === 2) {
          releaseProbes();
        }
        await bothProbesStarted;
      }
      return true;
    };
    const common = {
      region: "eu10",
      org: "org-a",
      space: "dev",
      apiEndpoint: "https://example.com",
      cfHomeForSession: (id: string) => join(tempDir, id),
    };

    const [first, second] = await Promise.all([
      registerNewSession({ ...common, app: "concurrent-app-a", portProbe: recordProbe(probesA) }),
      registerNewSession({ ...common, app: "concurrent-app-b", portProbe: recordProbe(probesB) }),
    ]);

    expect(probesA[0]).toEqual(expect.any(Number));
    expect(probesB[0]).toEqual(expect.any(Number));
    expect(probesA[0]).not.toBe(probesB[0]);
    expect(first.session.localPort).toBe(probesA[0]);
    expect(second.session.localPort).toBe(probesB[0]);
  });

  it("scans the complete configured range in circular order", async () => {
    const probed: number[] = [];
    const basePort = 30_000;
    const maxPort = 30_016;

    await expect(registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "wraparound-app-0",
      apiEndpoint: "https://example.com",
      basePort,
      maxPort,
      portProbe: async (port): Promise<boolean> => {
        probed.push(port);
        return false;
      },
      cfHomeForSession: (id) => join(tempDir, id),
    })).rejects.toMatchObject({ code: "PORT_UNAVAILABLE" });

    expect(probed).toHaveLength(maxPort - basePort + 1);
    expect(new Set(probed)).toEqual(new Set(
      Array.from({ length: maxPort - basePort + 1 }, (_, index) => basePort + index),
    ));
    expect(probed[0]).toBe(30_004);
    for (let index = 1; index < probed.length; index += 1) {
      const previous = probed[index - 1];
      const current = probed[index];
      if (previous === undefined || current === undefined) {
        throw new Error("expected a complete port scan");
      }
      expect(current).toBe(previous === maxPort ? basePort : previous + 1);
    }
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

  it("prioritizes a valid preferred port outside the configured scan range", async () => {
    const probes: number[] = [];
    const result = await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      preferredPort: 20_555,
      basePort: 30_000,
      maxPort: 30_002,
      portProbe: async (port): Promise<boolean> => {
        probes.push(port);
        return true;
      },
      cfHomeForSession: (id) => join(tempDir, id),
    });

    expect(result.session.localPort).toBe(20_555);
    expect(probes).toEqual([20_555, 20_555]);
  });

  it("skips an unavailable preferred port and uses the key-derived fallback", async () => {
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

    expect(result.session.localPort).toBe(20_459);
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

  it.each([
    ["preferredPort below range", { preferredPort: 0 }],
    ["preferredPort above range", { preferredPort: 65_536 }],
    ["preferredPort fractional", { preferredPort: 20_000.5 }],
    ["basePort below range", { basePort: 0 }],
    ["basePort above range", { basePort: 65_536 }],
    ["basePort fractional", { basePort: 20_000.5 }],
    ["basePort non-finite", { basePort: Number.NaN }],
    ["maxPort below range", { maxPort: 0 }],
    ["maxPort above range", { maxPort: 65_536 }],
    ["maxPort fractional", { maxPort: 20_000.5 }],
    ["maxPort non-finite", { maxPort: Number.POSITIVE_INFINITY }],
    ["inverted scan range", { basePort: 30_001, maxPort: 30_000 }],
  ])("rejects invalid local port configuration: %s", async (_label, overrides) => {
    const portProbe = vi.fn(async (): Promise<boolean> => true);
    await expect(registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      portProbe,
      cfHomeForSession: (id) => join(tempDir, id),
      ...overrides,
    })).rejects.toMatchObject({ code: "UNSAFE_INPUT" });

    expect(portProbe).not.toHaveBeenCalled();
    await expect(access(join(tempDir, "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["region", { region: "" }],
    ["org", { org: " org-a" }],
    ["space", { space: "-dev" }],
    ["app", { app: "demo\napp" }],
    ["apiEndpoint", { apiEndpoint: "https://example.com " }],
  ])("rejects unsafe direct registration %s before side effects", async (_label, overrides) => {
    const portProbe = vi.fn(async (): Promise<boolean> => true);
    await expect(registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      portProbe,
      cfHomeForSession: (id) => join(tempDir, id),
      ...overrides,
    })).rejects.toMatchObject({ code: "UNSAFE_INPUT" });

    expect(portProbe).not.toHaveBeenCalled();
    await expect(access(join(tempDir, "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
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

  it("records both stop-intent sources for a ready session", async () => {
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

    const claim = await requestSessionStop(result.session.sessionId);

    expect(claim?.previousStatus).toBe("ready");
    expect(claim?.session.stopRequestedAt).toEqual(expect.any(String));
    await expect(hasSessionStopIntent(result.session.sessionId)).resolves.toBe(true);
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

  it("clears an old tunnel identity when the replacement PID has no token", async () => {
    const statePath = join(tempDir, "state.json");
    await writeFile(statePath, JSON.stringify({
      version: "2",
      sessions: [persistedSession(tempDir, {
        status: "tunneling",
        tunnelPid: process.pid,
        tunnelProcessIdentity: "old-process-token",
      })],
    }), "utf8");
    const definitelyDead = 2_147_483_600;

    await updateSessionPid("session-a", definitelyDead);

    expect((await readSessionSnapshot())[0]).toEqual(expect.objectContaining({
      pid: definitelyDead,
      tunnelPid: definitelyDead,
    }));
    expect((await readSessionSnapshot())[0]?.tunnelProcessIdentity).toBeUndefined();
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

  it("moves invalid JSON aside before replacing it with empty state", async () => {
    const statePath = join(tempDir, "state.json");
    await writeFile(statePath, "{not json", "utf8");

    await expect(readActiveSessions()).resolves.toEqual([]);
    const files = await readdir(tempDir);
    const backup = files.find((name) => name.startsWith("state.json.corrupt-"));
    expect(backup).toEqual(expect.any(String));
    if (backup === undefined) {
      throw new Error("expected corrupt-state backup");
    }
    expect(await readFile(join(tempDir, backup), "utf8")).toBe("{not json");
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
      version: "2",
      sessions: [],
    });
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

  it("inspects health outside the lock and retains a session changed before prune persistence", async () => {
    const statePath = join(tempDir, "state.json");
    const session = persistedSession(tempDir, {
      sessionId: "health-race",
      pid: process.pid,
      tunnelPid: process.pid,
      status: "ready",
    });
    await writeFile(statePath, JSON.stringify({
      version: "2",
      sessions: [session],
    }), "utf8");
    let inspections = 0;
    vi.spyOn(health, "inspectSessionHealth").mockImplementation(
      async (): Promise<health.SessionHealthVerdict> => {
        inspections += 1;
        await expect(access(join(tempDir, "state.lock"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await writeFile(statePath, JSON.stringify({
          version: "2",
          sessions: [{ ...session, message: "became healthy" }],
        }), "utf8");
        return { status: "stale", reason: "first snapshot was stale" };
      },
    );

    await expect(readActiveSessions()).resolves.toEqual([
      expect.objectContaining({
        message: "became healthy",
        sessionId: "health-race",
      }),
    ]);
    expect(inspections).toBe(1);
  });

  it("revalidates an unchanged stale candidate and retains it when it becomes healthy", async () => {
    const session = persistedSession(tempDir, {
      sessionId: "health-revalidation",
      pid: process.pid,
      tunnelPid: process.pid,
      status: "ready",
    });
    await writeFile(join(tempDir, "state.json"), JSON.stringify({
      version: "2",
      sessions: [session],
    }), "utf8");
    let inspections = 0;
    vi.spyOn(health, "inspectSessionHealth").mockImplementation(
      async (): Promise<health.SessionHealthVerdict> => {
        inspections += 1;
        if (inspections === 1) {
          await expect(access(join(tempDir, "state.lock"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          return { status: "stale", reason: "temporarily stale" };
        }
        await expect(access(join(tempDir, "state.lock"))).resolves.toBeUndefined();
        return { status: "healthy", reason: "became healthy" };
      },
    );

    await expect(readActiveSessions()).resolves.toEqual([
      expect.objectContaining({ sessionId: "health-revalidation" }),
    ]);
    expect(inspections).toBe(2);
    await expect(readSessionSnapshot()).resolves.toHaveLength(1);
  });

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "prunes a live controller PID whose persisted identity token does not match",
    async () => {
      await writeFile(
        join(tempDir, "state.json"),
        JSON.stringify({
          version: "2",
          sessions: [persistedSession(tempDir, {
            sessionId: "reused-controller",
            controllerProcessIdentity: process.platform === "linux"
              ? "linux:v1:0"
              : "darwin:v1:Thu Jan 1 00:00:00 1970",
          })],
        }),
        "utf8",
      );

      const replacement = await registerNewSession({
        region: "eu10",
        org: "org-a",
        space: "dev",
        app: "demo-app",
        apiEndpoint: "https://example.com",
        portProbe: async () => true,
        sessionIdFactory: () => "replacement",
        cfHomeForSession: (id) => join(tempDir, id),
      });

      expect(replacement.existing).toBeUndefined();
      expect(replacement.session.sessionId).toBe("replacement");
    },
  );

  it("prunes an over-age starting entry even while its controller PID is alive", async () => {
    await writeFile(
      join(tempDir, "state.json"),
      JSON.stringify({
        version: "2",
        sessions: [persistedSession(tempDir, {
          sessionId: "over-age",
          startedAt: "1970-01-01T00:00:00.000Z",
          startupTimeoutMs: 1,
        })],
      }),
      "utf8",
    );

    const replacement = await registerNewSession({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://example.com",
      portProbe: async () => true,
      sessionIdFactory: () => "replacement",
      cfHomeForSession: (id) => join(tempDir, id),
    });

    expect(replacement.existing).toBeUndefined();
    expect(replacement.session.sessionId).toBe("replacement");
  });

  it("retains an over-age startup record when its verified tunnel still owns the port", async () => {
    const { server, port } = await listenOnEphemeralPort();
    try {
      await writeFile(
        join(tempDir, "state.json"),
        JSON.stringify({
          version: "2",
          sessions: [persistedSession(tempDir, {
            sessionId: "over-age-with-tunnel",
            pid: process.pid,
            tunnelPid: process.pid,
            localPort: port,
            startedAt: "1970-01-01T00:00:00.000Z",
            startupTimeoutMs: 1,
            status: "tunneling",
          })],
        }),
        "utf8",
      );

      await expect(readActiveSessions()).resolves.toEqual([
        expect.objectContaining({ sessionId: "over-age-with-tunnel" }),
      ]);
    } finally {
      await closeServer(server);
    }
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

  it("retains a live ready session whose tunnel port is no longer listening", async () => {
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

  it("retains ready state when a live recorded process no longer owns its port", async () => {
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

  it("retains a same-key live session that no longer owns its recorded port", async () => {
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

describe("session recovery", () => {
  let tempDir: string;
  let previousHome: string | undefined;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cf-debugger-recovery-"));
    previousHome = process.env["HOME"];
    process.env["HOME"] = tempDir;
    vi.spyOn(paths, "stateFilePath").mockReturnValue(join(tempDir, "state.json"));
    vi.spyOn(paths, "stateLockPath").mockReturnValue(join(tempDir, "state.lock"));
  });

  afterEach(async () => {
    for (const child of children.splice(0).reverse()) {
      await stopTestChild(child);
    }
    if (previousHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = previousHome;
    }
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("resolves an old stop request after its startup controller exits", async () => {
    const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const exitedPid = requireChildPid(exited);
    await once(exited, "close");
    const { server, port } = await listenOnEphemeralPort();
    await closeServer(server);
    const sessionId = "old-stop-request";
    const cfHomeDir = paths.sessionCfHomeDir(sessionId);
    await mkdir(cfHomeDir, { recursive: true });
    await writeFile(join(tempDir, "state.json"), JSON.stringify({
      version: "2",
      sessions: [persistedSession(tempDir, {
        sessionId,
        pid: exitedPid,
        controllerPid: exitedPid,
        localPort: port,
        cfHomeDir,
        startedAt: "1970-01-01T00:00:00.000Z",
        stopRequestedAt: "1970-01-01T00:00:01.000Z",
      })],
    }), "utf8");

    const result = await stopDebugger({ sessionId });

    expect(result).toEqual(expect.objectContaining({
      sessionId,
      pending: false,
      stale: true,
    }));
    await expect(readSessionSnapshot()).resolves.toEqual([]);
    await expect(access(cfHomeDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("force-forgets a live starting controller instead of leaving a permanent pending record", async () => {
    const { server, port } = await listenOnEphemeralPort();
    await closeServer(server);
    const sessionId = "wedged-live-controller";
    const cfHomeDir = paths.sessionCfHomeDir(sessionId);
    await mkdir(cfHomeDir, { recursive: true });
    await writeFile(join(tempDir, "state.json"), JSON.stringify({
      version: "2",
      sessions: [persistedSession(tempDir, {
        sessionId,
        pid: process.pid,
        controllerPid: process.pid,
        localPort: port,
        cfHomeDir,
        status: "starting",
      })],
    }), "utf8");

    await expect(stopDebugger({ sessionId })).resolves.toMatchObject({
      pending: true,
      stale: false,
    });
    const forced = await stopDebugger({ sessionId, force: true });

    expect(forced).toEqual(expect.objectContaining({
      forced: true,
      pending: false,
      stale: true,
      warning: expect.stringContaining(`PID ${process.pid.toString()}`),
    }));
    await expect(readSessionSnapshot()).resolves.toEqual([]);
    await expect(access(cfHomeDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")(
    "force-forgets state before an owned home cleanup failure and leaves a doctor-visible orphan",
    async () => {
      const { server, port } = await listenOnEphemeralPort();
      await closeServer(server);
      const sessionId = "force-home-cleanup-failure";
      const cfHomeDir = paths.sessionCfHomeDir(sessionId);
      const lockedDir = join(cfHomeDir, "locked");
      await mkdir(lockedDir, { recursive: true });
      await writeFile(join(lockedDir, "token-bearing-config.json"), "secret", "utf8");
      await chmod(lockedDir, 0o500);
      await writeFile(join(tempDir, "state.json"), JSON.stringify({
        version: "2",
        sessions: [persistedSession(tempDir, {
          sessionId,
          pid: process.pid,
          controllerPid: process.pid,
          localPort: port,
          cfHomeDir,
          status: "starting",
        })],
      }), "utf8");

      try {
        const forced = await stopDebugger({ sessionId, force: true });

        expect(forced).toEqual(expect.objectContaining({
          forced: true,
          warning: expect.stringMatching(/live CF refresh token.*doctor --cleanup/i),
        }));
        await expect(readSessionSnapshot()).resolves.toEqual([]);
        await expect(access(cfHomeDir)).resolves.toBeUndefined();
        const doctor = await runDoctor();
        expect(doctor.orphanHomes).toContainEqual(expect.objectContaining({
          path: cfHomeDir,
          sessionId,
        }));
      } finally {
        await chmod(lockedDir, 0o700).catch(() => undefined);
      }
    },
  );

  it("force-forgets a stranger-owned port without signalling either child", async () => {
    const listener = await spawnListeningChild();
    const sleeper = await spawnSleeperChild();
    children.push(listener.child, sleeper);
    const sessionId = "stranger-owned-port";
    const cfHomeDir = paths.sessionCfHomeDir(sessionId);
    await mkdir(cfHomeDir, { recursive: true });
    const tunnelPid = requireChildPid(sleeper);
    await writeFile(join(tempDir, "state.json"), JSON.stringify({
      version: "2",
      sessions: [persistedSession(tempDir, {
        sessionId,
        pid: tunnelPid,
        controllerPid: process.pid,
        tunnelPid,
        localPort: listener.port,
        cfHomeDir,
        status: "ready",
      })],
    }), "utf8");

    await expect(stopDebugger({ sessionId })).rejects.toMatchObject({
      code: "TUNNEL_OWNERSHIP_UNVERIFIED",
    });
    expect(sleeper.exitCode).toBeNull();
    expect(listener.child.exitCode).toBeNull();
    await expect(readSessionSnapshot()).resolves.toHaveLength(1);

    const forced = await stopDebugger({ sessionId, force: true });

    expect(forced).toEqual(expect.objectContaining({
      forced: true,
      pending: false,
      stale: true,
      warning: expect.stringContaining("No unverified process was signalled"),
    }));
    expect(sleeper.exitCode).toBeNull();
    expect(listener.child.exitCode).toBeNull();
    await expect(readSessionSnapshot()).resolves.toEqual([]);
    await expect(hasSessionStopIntent(sessionId)).resolves.toBe(false);
    await expect(access(cfHomeDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("force-forgets a corrupt record without deleting its unowned CF home path", async () => {
    const listener = await spawnListeningChild();
    const sleeper = await spawnSleeperChild();
    children.push(listener.child, sleeper);
    const sessionId = "unowned-home-record";
    const unownedHome = join(tempDir, "user-controlled-directory");
    await mkdir(unownedHome, { recursive: true });
    const tunnelPid = requireChildPid(sleeper);
    await writeFile(join(tempDir, "state.json"), JSON.stringify({
      version: "2",
      sessions: [persistedSession(tempDir, {
        sessionId,
        pid: tunnelPid,
        tunnelPid,
        localPort: listener.port,
        cfHomeDir: unownedHome,
        status: "ready",
      })],
    }), "utf8");

    const forced = await stopDebugger({ sessionId, force: true });

    expect(forced?.warning).toContain("referenced unowned CF home");
    expect(sleeper.exitCode).toBeNull();
    expect(listener.child.exitCode).toBeNull();
    await expect(readSessionSnapshot()).resolves.toEqual([]);
    await expect(access(unownedHome)).resolves.toBeUndefined();
  });

  it("stop-all continues after an ownership failure and reports every outcome", async () => {
    const listener = await spawnListeningChild();
    const sleeper = await spawnSleeperChild();
    children.push(listener.child, sleeper);
    const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const exitedPid = requireChildPid(exited);
    await once(exited, "close");
    const { server, port: closedPort } = await listenOnEphemeralPort();
    await closeServer(server);
    const failedId = "batch-owner-mismatch";
    const staleId = "batch-stale";
    const failedHome = paths.sessionCfHomeDir(failedId);
    const staleHome = paths.sessionCfHomeDir(staleId);
    await mkdir(failedHome, { recursive: true });
    await mkdir(staleHome, { recursive: true });
    const tunnelPid = requireChildPid(sleeper);
    await writeFile(join(tempDir, "state.json"), JSON.stringify({
      version: "2",
      sessions: [
        persistedSession(tempDir, {
          sessionId: failedId,
          pid: tunnelPid,
          tunnelPid,
          localPort: listener.port,
          cfHomeDir: failedHome,
          status: "ready",
        }),
        persistedSession(tempDir, {
          sessionId: staleId,
          pid: exitedPid,
          controllerPid: exitedPid,
          localPort: closedPort,
          cfHomeDir: staleHome,
          startedAt: "1970-01-01T00:00:00.000Z",
          app: "second-app",
        }),
      ],
    }), "utf8");

    const result = await stopAllDebuggers();

    expect(result).toMatchObject({
      failed: 1,
      forced: 0,
      pending: 0,
      stale: 1,
      stopped: 0,
    });
    expect(result.outcomes.map((outcome) => ({
      sessionId: outcome.sessionId,
      status: outcome.status,
    }))).toEqual([
      { sessionId: failedId, status: "failed" },
      { sessionId: staleId, status: "stale" },
    ]);
    expect(result.outcomes[0]?.error?.code).toBe("TUNNEL_OWNERSHIP_UNVERIFIED");
    expect(sleeper.exitCode).toBeNull();
    expect(listener.child.exitCode).toBeNull();
    expect((await readSessionSnapshot()).map((session) => session.sessionId)).toEqual([
      failedId,
    ]);
    await expect(access(staleHome)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(failedHome)).resolves.toBeUndefined();
  });
});
