import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CfExplorerError } from "../../src/errors.js";
import { createIpcServer, type IpcRequest } from "../../src/ipc.js";
import {
  attachExplorerSession,
  getExplorerSessionStatus,
  listExplorerSessions,
  startExplorerSession,
  stopExplorerSession,
} from "../../src/session.js";
import { markSessionsStaleForTarget, registerExplorerSession } from "../../src/storage.js";

describe("persistent session client", () => {
  let homeDir: string;
  let server: Server | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "cf-explorer-session-"));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server?.close(() => {
        resolve();
      });
      if (server === undefined) {
        resolve();
      }
    });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("preserves broker-side typed error codes for callers", async () => {
    const session = await registerExplorerSession({
      sessionId: "session-error",
      brokerPid: process.pid,
      target: { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      process: "web",
      instance: 0,
      homeDir,
      status: "ready",
    });
    server = await createIpcServer(session.socketPath, async (request) => ({
      requestId: request.requestId,
      ok: false,
      durationMs: 1,
      error: { code: "UNSAFE_INPUT", message: "bad input" },
    }));

    const attached = await attachExplorerSession(session.sessionId, { homeDir });
    await expect(attached.roots()).rejects.toMatchObject({ code: "UNSAFE_INPUT" });
  });

  it("lists sessions, reports status, and returns successful broker results", async () => {
    const session = await registerExplorerSession({
      sessionId: "session-ok",
      brokerPid: process.pid,
      target: { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      process: "web",
      instance: 0,
      homeDir,
      status: "ready",
    });
    let seenRequest: IpcRequest | undefined;
    server = await createIpcServer(session.socketPath, async (request) => {
      seenRequest = request;
      return {
        requestId: request.requestId,
        ok: true,
        durationMs: 1,
        result: {
          meta: {
            target: session.target,
            process: "web",
            instance: 0,
            durationMs: 1,
            truncated: false,
          },
          roots: ["/workspace/app"],
        },
      };
    });

    await expect(listExplorerSessions({ homeDir })).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId: "session-ok" })],
    });
    await expect(getExplorerSessionStatus("session-ok", { homeDir })).resolves.toMatchObject({
      sessionId: "session-ok",
      brokerAlive: true,
      socketAlive: true,
    });
    const attached = await attachExplorerSession("session-ok", { homeDir });
    await expect(attached.roots({ timeoutMs: 123, maxBytes: 456 })).resolves.toMatchObject({
      roots: ["/workspace/app"],
    });
    expect(seenRequest).toMatchObject({
      timeoutMs: 123,
      args: { timeoutMs: 123, maxBytes: 456 },
    });
    await expect(attached.roots({ timeoutMs: -1 })).rejects.toMatchObject({ code: "UNSAFE_INPUT" });
    await expect(stopExplorerSession({ sessionId: "missing", runtime: { homeDir } })).resolves.toBe(0);
    await expect(stopExplorerSession({ runtime: { homeDir } })).rejects.toMatchObject({ code: "UNSAFE_INPUT" });
    await expect(stopExplorerSession({ sessionId: "session-ok", all: true, runtime: { homeDir } }))
      .rejects.toMatchObject({ code: "UNSAFE_INPUT" });
  });

  it("rejects stale sessions before sending more IPC requests", async () => {
    const session = await registerExplorerSession({
      sessionId: "session-stale",
      brokerPid: process.pid,
      target: { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      process: "web",
      instance: 0,
      homeDir,
      status: "ready",
    });
    server = await createIpcServer(session.socketPath, async (request) => ({
      requestId: request.requestId,
      ok: true,
      durationMs: 1,
      result: {
        meta: { target: session.target, process: "web", instance: 0, durationMs: 1, truncated: false },
        roots: ["/workspace/app"],
      },
    }));
    const attached = await attachExplorerSession(session.sessionId, { homeDir });
    await expect(attached.roots()).resolves.toMatchObject({ roots: ["/workspace/app"] });

    await registerExplorerSession({
      sessionId: "other-session",
      brokerPid: process.pid,
      target: { region: "ap10", org: "org", space: "dev", app: "other-app" },
      process: "web",
      instance: 0,
      homeDir,
    });
    await markSessionsStaleForTarget(homeDir, session.target, "restart");

    await expect(attachExplorerSession(session.sessionId, { homeDir }))
      .rejects.toMatchObject({ code: "SESSION_STALE" });
    await expect(attached.roots()).rejects.toMatchObject({ code: "SESSION_STALE" });
  });

  it("rejects all-instance persistent session starts before spawning a broker", async () => {
    await expect(startExplorerSession({
      target: { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      runtime: { homeDir },
      allInstances: true,
    })).rejects.toThrow(CfExplorerError);
  });
});
