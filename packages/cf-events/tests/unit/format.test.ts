import { describe, expect, it } from "vitest";

import {
  describeEventType,
  formatBytes,
  formatCpu,
  formatCrashReport,
  formatEventLine,
  formatEventsReport,
  formatRelativeTime,
  formatSshStatusReport,
  formatStatusReport,
  formatUptime,
} from "../../src/format.js";
import type { AppHealth, CrashSummary, SshStatus } from "../../src/types.js";

import { makeEvent } from "./factories.js";

const NOW = new Date("2026-05-22T12:00:00.000Z");

describe("describeEventType", () => {
  it("returns a friendly label for known types", () => {
    expect(describeEventType("audit.app.ssh-authorized")).toBe("SSH session authorized");
  });

  it("returns the raw type for unknown types", () => {
    expect(describeEventType("audit.app.something")).toBe("audit.app.something");
  });
});

describe("formatUptime", () => {
  it("returns a dash for missing or non-positive values", () => {
    expect(formatUptime(undefined)).toBe("-");
    expect(formatUptime(0)).toBe("-");
  });

  it("formats minutes, hours, and days", () => {
    expect(formatUptime(90)).toBe("1m");
    expect(formatUptime(3_660)).toBe("1h 1m");
    expect(formatUptime(90_000)).toBe("1d 1h");
  });
});

describe("formatBytes", () => {
  it("returns a dash for missing or negative values", () => {
    expect(formatBytes(undefined)).toBe("-");
    expect(formatBytes(-1)).toBe("-");
  });

  it("formats byte and binary units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
  });
});

describe("formatCpu", () => {
  it("returns a dash when undefined", () => {
    expect(formatCpu(undefined)).toBe("-");
  });

  it("formats a fraction as a percentage", () => {
    expect(formatCpu(0.124)).toBe("12.4%");
  });
});

describe("formatRelativeTime", () => {
  it("returns 'unknown' for an unparseable timestamp", () => {
    expect(formatRelativeTime("not-a-date", NOW)).toBe("unknown");
  });

  it("describes recent and older timestamps", () => {
    expect(formatRelativeTime("2026-05-22T11:59:30.000Z", NOW)).toBe("just now");
    expect(formatRelativeTime("2026-05-22T11:30:00.000Z", NOW)).toBe("30m ago");
    expect(formatRelativeTime("2026-05-22T09:00:00.000Z", NOW)).toBe("3h ago");
    expect(formatRelativeTime("2026-05-19T12:00:00.000Z", NOW)).toBe("3d ago");
  });
});

describe("formatEventsReport / formatEventLine", () => {
  it("reports when there are no events", () => {
    expect(formatEventsReport("orders-srv", [], NOW)).toBe("No audit events found for orders-srv.");
  });

  it("renders a header and one line per event", () => {
    const report = formatEventsReport("orders-srv", [makeEvent({ type: "audit.app.start" })], NOW);
    expect(report).toContain("Audit events for orders-srv (1):");
    expect(report).toContain("App started");
    expect(report).toContain("user@example.com");
  });

  it("falls back to a placeholder when the actor is unknown", () => {
    const line = formatEventLine(makeEvent({ actor: { guid: "", type: "", name: "" } }), NOW);
    expect(line).toContain("(unknown actor)");
  });
});

describe("formatSshStatusReport", () => {
  it("renders enabled status with sessions and denied attempts", () => {
    const status: SshStatus = {
      appName: "orders-srv",
      sshEnabled: true,
      sshReason: "",
      sessions: [
        { actor: "user@example.com", authorizedAt: "2026-05-22T11:50:00.000Z", likelyActive: true },
      ],
      deniedAttempts: [makeEvent({ type: "audit.app.ssh-unauthorized" })],
      activeSessionCount: 1,
    };
    const report = formatSshStatusReport(status, NOW);
    expect(report).toContain("SSH enabled:            yes");
    expect(report).toContain("[active]");
    expect(report).toContain("Denied SSH attempts: 1");
    expect(report).toContain("inferred from recent ssh-authorized");
  });

  it("shows the disabled reason when SSH is off", () => {
    const status: SshStatus = {
      appName: "orders-srv",
      sshEnabled: false,
      sshReason: "Disabled for the space",
      sessions: [],
      deniedAttempts: [],
      activeSessionCount: 0,
    };
    const report = formatSshStatusReport(status, NOW);
    expect(report).toContain("SSH enabled:            no");
    expect(report).toContain("Disabled reason:        Disabled for the space");
  });
});

describe("formatCrashReport", () => {
  it("reports when there are no crashes", () => {
    const summary: CrashSummary = {
      appName: "orders-srv",
      crashCount: 0,
      lastCrashAt: undefined,
      lastCrashReason: undefined,
      crashes: [],
    };
    expect(formatCrashReport(summary, NOW)).toBe("No crashes found for orders-srv.");
  });

  it("renders a crash summary with details", () => {
    const summary: CrashSummary = {
      appName: "orders-srv",
      crashCount: 1,
      lastCrashAt: "2026-05-22T11:00:00.000Z",
      lastCrashReason: "CRASHED",
      crashes: [{ at: "2026-05-22T11:00:00.000Z", index: 0, reason: "CRASHED", exitStatus: 1 }],
    };
    const report = formatCrashReport(summary, NOW);
    expect(report).toContain("Crashes: 1");
    expect(report).toContain("Last reason: CRASHED");
    expect(report).toContain("exit 1");
  });
});

describe("formatStatusReport", () => {
  it("renders app health with instances and the last event", () => {
    const health: AppHealth = {
      appName: "orders-srv",
      appGuid: "app-guid-1",
      requestedState: "STARTED",
      sshEnabled: true,
      instances: [
        {
          type: "web",
          index: 0,
          state: "RUNNING",
          uptimeSeconds: 3_660,
          cpu: 0.1,
          memBytes: 2048,
          memQuotaBytes: 4096,
          diskBytes: 1024,
          diskQuotaBytes: 2048,
        },
      ],
      lastEvent: makeEvent({ type: "audit.app.start" }),
    };
    const report = formatStatusReport(health, NOW);
    expect(report).toContain("App status: orders-srv");
    expect(report).toContain("Requested state: STARTED");
    expect(report).toContain("RUNNING");
    expect(report).toContain("Last event: App started");
  });

  it("handles an app with no instances and no last event", () => {
    const health: AppHealth = {
      appName: "orders-srv",
      appGuid: "app-guid-1",
      requestedState: "",
      sshEnabled: false,
      instances: [],
      lastEvent: undefined,
    };
    const report = formatStatusReport(health, NOW);
    expect(report).toContain("Requested state: unknown");
    expect(report).toContain("Last event: (none)");
  });
});
