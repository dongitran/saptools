import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as lock from "../../src/lock.js";
import * as paths from "../../src/paths.js";
import { inspectSessionStateStopIntent } from "../../src/session-state/stop-intent.js";
import type { ActiveSession } from "../../src/types.js";

let tempDir = "";
let statePath = "";

function persistedSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
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
    apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
    localPort: 20_000,
    remotePort: 9_229,
    cfHomeDir: join(tempDir, "homes", "session-a"),
    startedAt: new Date().toISOString(),
    status: "starting",
    ...overrides,
  };
}

async function writeState(sessions: readonly ActiveSession[]): Promise<void> {
  await writeFile(statePath, JSON.stringify({ version: "2", sessions }), "utf8");
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cf-debugger-stop-intent-"));
  statePath = join(tempDir, "state.json");
  vi.spyOn(paths, "stateFilePath").mockReturnValue(statePath);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe("unlocked session-state stop intent", () => {
  it("distinguishes active state, a stop request, and a missing record", async () => {
    await writeState([persistedSession()]);
    await expect(inspectSessionStateStopIntent("session-a")).resolves.toBe("active");

    await writeState([persistedSession({
      stopRequestedAt: "2026-07-29T00:00:00.000Z",
    })]);
    await expect(inspectSessionStateStopIntent("session-a")).resolves.toBe("requested");

    await writeState([]);
    await expect(inspectSessionStateStopIntent("session-a")).resolves.toBe("missing");
  });

  it("treats an absent state file as a missing session record", async () => {
    await expect(inspectSessionStateStopIntent("session-a")).resolves.toBe("missing");
  });

  it("treats corrupt state and read failures as unavailable", async () => {
    await writeFile(statePath, "{not-json", "utf8");
    await expect(inspectSessionStateStopIntent("session-a")).resolves.toBe("unavailable");

    await rm(statePath, { force: true });
    await mkdir(statePath);
    await expect(inspectSessionStateStopIntent("session-a")).resolves.toBe("unavailable");
  });

  it("retains a valid stop request when an unrelated state entry is malformed", async () => {
    await writeFile(statePath, JSON.stringify({
      version: "2",
      sessions: [
        persistedSession({ stopRequestedAt: "2026-07-29T00:00:00.000Z" }),
        { sessionId: "malformed" },
      ],
    }), "utf8");

    await expect(inspectSessionStateStopIntent("session-a")).resolves.toBe("requested");
    await expect(inspectSessionStateStopIntent("absent")).resolves.toBe("unavailable");
  });

  it("reads state without acquiring the shared file lock", async () => {
    const lockSpy = vi.spyOn(lock, "withFileLock");
    await writeState([persistedSession()]);

    await expect(inspectSessionStateStopIntent("session-a")).resolves.toBe("active");

    expect(lockSpy).not.toHaveBeenCalled();
  });
});
