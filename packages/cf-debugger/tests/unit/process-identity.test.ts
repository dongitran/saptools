import { hostname } from "node:os";

import { describe, expect, it } from "vitest";

import {
  darwinIdentityEnvironment,
  inspectProcessIdentity,
  parseLinuxProcessStartTime,
  readProcessIdentity,
} from "../../src/debug-session/process-identity.js";
import { inspectSessionHealth } from "../../src/session-state/health.js";
import type { ActiveSession } from "../../src/types.js";

function linuxStatLine(command: string, startTime: string): string {
  const fieldsThreeThroughTwentyOne = [
    "R",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "11",
    "12",
    "13",
    "14",
    "15",
    "16",
    "17",
    "18",
  ];
  return `4242 (${command}) ${fieldsThreeThroughTwentyOne.join(" ")} ${startTime} 23 24`;
}

function differentCurrentIdentity(identity: string): string {
  return identity.startsWith("linux:v1:")
    ? "linux:v1:0"
    : "darwin:v1:Thu Jan 1 00:00:00 1970";
}

function startingSession(identity: string): ActiveSession {
  return {
    sessionId: "legacy-identity",
    pid: process.pid,
    controllerPid: process.pid,
    controllerProcessIdentity: identity,
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
    cfHomeDir: "/tmp/cf-debugger-legacy-identity",
    startedAt: new Date().toISOString(),
    status: "starting",
  };
}

describe("process identity", () => {
  it("parses Linux starttime after the last closing parenthesis", () => {
    const stat = linuxStatLine("worker name ) with a close", "987654321");

    expect(parseLinuxProcessStartTime(stat)).toBe("987654321");
  });

  it("rejects malformed Linux stat input", () => {
    expect(parseLinuxProcessStartTime("4242 no-command-fields")).toBeUndefined();
    expect(parseLinuxProcessStartTime(linuxStatLine("worker", "not-a-number"))).toBeUndefined();
  });

  it("uses PID-only compatibility when no persisted token exists", async () => {
    await expect(inspectProcessIdentity(process.pid, undefined)).resolves.toBe("match");
  });

  it("forces a stable Darwin ps environment", () => {
    expect(darwinIdentityEnvironment({
      LC_ALL: "fr_FR.UTF-8",
      PATH: "/usr/bin",
      TZ: "America/New_York",
    })).toEqual({
      LC_ALL: "C",
      PATH: "/usr/bin",
      TZ: "UTC",
    });
  });

  it.runIf(process.platform === "darwin")(
    "keeps a live Darwin identity stable across caller timezone changes",
    async () => {
      const originalTimezone = process.env["TZ"];
      try {
        process.env["TZ"] = "America/New_York";
        const first = await readProcessIdentity(process.pid);
        process.env["TZ"] = "Asia/Ho_Chi_Minh";
        const second = await readProcessIdentity(process.pid);

        expect(first).toEqual(expect.stringMatching(/^darwin:v1:/));
        expect(second).toBe(first);
      } finally {
        if (originalTimezone === undefined) {
          delete process.env["TZ"];
        } else {
          process.env["TZ"] = originalTimezone;
        }
      }
    },
  );

  it.each([
    "linux:12345",
    "darwin:Wed Jul 29 01:16:23 2026",
    "linux:v1:not-a-number",
    "darwin:v1:not-a-date",
    "future:v2:12345",
  ])("treats legacy or unparseable token %s as unavailable", async (identity) => {
    await expect(inspectProcessIdentity(process.pid, identity)).resolves.toBe("unavailable");
  });

  it("retains a live session whose legacy identity cannot be compared", async () => {
    await expect(
      inspectSessionHealth(startingSession("linux:12345")),
    ).resolves.toMatchObject({
      status: "unverified",
    });
  });

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "distinguishes a matching token from a reused PID token",
    async () => {
      const identity = await readProcessIdentity(process.pid);
      expect(identity).toEqual(expect.any(String));
      if (identity === undefined) {
        return;
      }

      expect(identity).toMatch(/^(?:darwin|linux):v1:/);
      await expect(inspectProcessIdentity(process.pid, identity)).resolves.toBe("match");
      await expect(
        inspectProcessIdentity(process.pid, differentCurrentIdentity(identity)),
      ).resolves.toBe("mismatch");
    },
  );
});
