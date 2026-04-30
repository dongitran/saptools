import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessionCfHomeDir, sessionSocketPath } from "../../src/paths.js";
import {
  cleanupSessionFiles,
  isPidAlive,
  listExplorerSessions,
  markSessionsStaleForTarget,
  matchesSessionTarget,
  pathExists,
  readExplorerSession,
  registerExplorerSession,
  removeExplorerSession,
  toSessionTarget,
  updateExplorerSession,
} from "../../src/storage.js";

describe("session storage", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "cf-explorer-storage-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("registers, updates, lists, and removes sessions", async () => {
    const session = await registerExplorerSession({
      brokerPid: process.pid,
      target: { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      process: "web",
      instance: 0,
      homeDir,
    });
    expect((await listExplorerSessions(homeDir))[0]?.sessionId).toBe(session.sessionId);

    await updateExplorerSession(homeDir, session.sessionId, { status: "ready", sshPid: process.pid });
    expect((await readExplorerSession(homeDir, session.sessionId))?.status).toBe("ready");

    await removeExplorerSession(homeDir, session.sessionId);
    expect(await listExplorerSessions(homeDir)).toEqual([]);
    expect(await updateExplorerSession(homeDir, "missing", { status: "ready" })).toBeUndefined();
  });

  it("rejects duplicate session ids", async () => {
    const input = {
      sessionId: "session-duplicate",
      brokerPid: process.pid,
      target: { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      process: "web",
      instance: 0,
      homeDir,
    } as const;

    await registerExplorerSession(input);
    await expect(registerExplorerSession(input)).rejects.toMatchObject({ code: "UNSAFE_INPUT" });
  });

  it("marks matching sessions stale without storing secrets", async () => {
    const target = { region: "ap10", org: "org", space: "dev", app: "demo-app" };
    await registerExplorerSession({
      sessionId: "session-a",
      brokerPid: process.pid,
      target,
      process: "web",
      instance: 0,
      homeDir,
    });
    const stale = await markSessionsStaleForTarget(homeDir, target, "restart");
    expect(stale[0]?.status).toBe("stale");
    const raw = await readFile(join(homeDir, "sessions.json"), "utf8");
    expect(raw).not.toContain("SAP_PASSWORD");
    expect(raw).not.toContain("secret");

    const untouchedTarget = { region: "ap10", org: "org", space: "dev", app: "other-app" };
    expect(await markSessionsStaleForTarget(homeDir, untouchedTarget, "restart")).toEqual([]);
  });

  it("prunes stopped and dead local sessions", async () => {
    await registerExplorerSession({
      sessionId: "stopped",
      brokerPid: process.pid,
      target: { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      process: "web",
      instance: 0,
      homeDir,
      status: "stopped",
    });
    await registerExplorerSession({
      sessionId: "dead",
      brokerPid: 2_147_483_600,
      target: { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      process: "web",
      instance: 0,
      homeDir,
    });
    await registerExplorerSession({
      sessionId: "error",
      brokerPid: 2_147_483_600,
      target: { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      process: "web",
      instance: 0,
      homeDir,
      status: "error",
    });
    expect((await listExplorerSessions(homeDir)).map((session) => session.sessionId)).toEqual([
      "error",
    ]);
    await removeExplorerSession(homeDir, "error");
    expect(await listExplorerSessions(homeDir)).toEqual([]);
  });

  it("resets invalid state files and prunes sessions from other hosts", async () => {
    await writeFile(join(homeDir, "sessions.json"), "not-json", "utf8");
    expect(await listExplorerSessions(homeDir)).toEqual([]);
    await writeFile(join(homeDir, "sessions.json"), "null", "utf8");
    expect(await listExplorerSessions(homeDir)).toEqual([]);
    await writeFile(join(homeDir, "sessions.json"), "{\"version\":1,\"sessions\":\"bad\"}", "utf8");
    expect(await listExplorerSessions(homeDir)).toEqual([]);

    await writeFile(
      join(homeDir, "sessions.json"),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            sessionId: "remote-host",
            brokerPid: 2_147_483_600,
            hostname: `${hostname()}-other`,
            socketPath: join(homeDir, "socket"),
            target: { region: "ap10", org: "org", space: "dev", app: "demo-app" },
            process: "web",
            instance: 0,
            cfHomeDir: join(homeDir, "cf-home"),
            startedAt: new Date().toISOString(),
            lastUsedAt: new Date().toISOString(),
            status: "ready",
          },
        ],
      }),
      "utf8",
    );
    expect(await listExplorerSessions(homeDir)).toEqual([]);
  });

  it("filters malformed session records from state files", async () => {
    const validSession = {
      sessionId: "valid",
      brokerPid: process.pid,
      hostname: hostname(),
      socketPath: sessionSocketPath("valid", homeDir),
      target: { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      process: "web",
      instance: 0,
      cfHomeDir: sessionCfHomeDir("valid", homeDir),
      startedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      status: "ready",
    };
    await writeFile(
      join(homeDir, "sessions.json"),
      JSON.stringify({ version: 1, sessions: [{ sessionId: "bad" }, validSession] }),
      "utf8",
    );
    expect((await listExplorerSessions(homeDir)).map((session) => session.sessionId)).toEqual([
      "valid",
    ]);
  });

  it("rejects unsafe session ids and cleanup paths outside the explorer home", async () => {
    await expect(registerExplorerSession({
      sessionId: "../bad",
      brokerPid: process.pid,
      target: { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      process: "web",
      instance: 0,
      homeDir,
    })).rejects.toMatchObject({ code: "UNSAFE_INPUT" });

    const session = await registerExplorerSession({
      sessionId: "session-safe",
      brokerPid: process.pid,
      target: { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      process: "web",
      instance: 0,
      homeDir,
    });
    await expect(cleanupSessionFiles({ ...session, cfHomeDir: "/" }, homeDir))
      .rejects.toMatchObject({ code: "UNSAFE_INPUT" });
  });

  it("cleans up cf-home and socket files when pruning crashed local sessions", async () => {
    const sessionId = "dead-cleanup";
    const cfHome = sessionCfHomeDir(sessionId, homeDir);
    const socketPath = sessionSocketPath(sessionId, homeDir);
    await mkdir(cfHome, { recursive: true });
    await writeFile(join(cfHome, "config.json"), "{}", "utf8");
    await mkdir(dirname(socketPath), { recursive: true });
    await writeFile(socketPath, "", "utf8");
    await registerExplorerSession({
      sessionId,
      brokerPid: 2_147_483_600,
      target: { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      process: "web",
      instance: 0,
      homeDir,
    });
    expect(await listExplorerSessions(homeDir)).toEqual([]);
    expect(await pathExists(cfHome)).toBe(false);
    expect(await pathExists(socketPath)).toBe(false);
  });

  it("exposes pid, path, and target helpers", async () => {
    const session = await registerExplorerSession({
      sessionId: "session-b",
      brokerPid: process.pid,
      target: { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      process: "web",
      instance: 0,
      homeDir,
    });
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(undefined)).toBe(false);
    expect(await pathExists(join(homeDir, "missing"))).toBe(false);
    expect(matchesSessionTarget(session, session.target)).toBe(true);
    expect(toSessionTarget(session)).toMatchObject({ app: "demo-app", process: "web", instance: 0 });
    await cleanupSessionFiles(session, homeDir);
  });
});
