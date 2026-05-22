import { describe, expect, it } from "vitest";

import { buildSshStatus, inferSshSessions } from "../../src/ssh.js";

import { makeEvent } from "./factories.js";

const NOW = new Date("2026-05-22T12:00:00.000Z");

describe("inferSshSessions", () => {
  it("maps ssh-authorized events to sessions", () => {
    const sessions = inferSshSessions(
      [makeEvent({ type: "audit.app.ssh-authorized", createdAt: "2026-05-22T11:30:00.000Z" })],
      NOW,
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.actor).toBe("user@example.com");
    expect(sessions[0]?.likelyActive).toBe(true);
  });

  it("marks sessions outside the active window as not likely active", () => {
    const sessions = inferSshSessions(
      [makeEvent({ type: "audit.app.ssh-authorized", createdAt: "2026-05-20T00:00:00.000Z" })],
      NOW,
    );
    expect(sessions[0]?.likelyActive).toBe(false);
  });

  it("ignores denied attempts and other event types", () => {
    expect(
      inferSshSessions([makeEvent({ type: "audit.app.ssh-unauthorized" })], NOW),
    ).toHaveLength(0);
  });

  it("falls back to the actor guid when the actor name is empty", () => {
    const sessions = inferSshSessions(
      [
        makeEvent({
          type: "audit.app.ssh-authorized",
          actor: { guid: "actor-guid", type: "user", name: "" },
        }),
      ],
      NOW,
    );
    expect(sessions[0]?.actor).toBe("actor-guid");
  });

  it("treats an unparseable timestamp as not active", () => {
    const sessions = inferSshSessions(
      [makeEvent({ type: "audit.app.ssh-authorized", createdAt: "not-a-date" })],
      NOW,
    );
    expect(sessions[0]?.likelyActive).toBe(false);
  });
});

describe("buildSshStatus", () => {
  it("aggregates sessions, denied attempts, and the active count", () => {
    const status = buildSshStatus({
      appName: "orders-srv",
      sshEnabled: true,
      sshReason: "",
      now: NOW,
      events: [
        makeEvent({
          guid: "a",
          type: "audit.app.ssh-authorized",
          createdAt: "2026-05-22T11:50:00.000Z",
        }),
        makeEvent({
          guid: "b",
          type: "audit.app.ssh-authorized",
          createdAt: "2026-05-20T00:00:00.000Z",
        }),
        makeEvent({ guid: "d", type: "audit.app.ssh-unauthorized" }),
        makeEvent({ guid: "x", type: "audit.app.start" }),
      ],
    });
    expect(status.appName).toBe("orders-srv");
    expect(status.sessions).toHaveLength(2);
    expect(status.activeSessionCount).toBe(1);
    expect(status.deniedAttempts).toHaveLength(1);
  });

  it("carries the disabled reason when SSH is off", () => {
    const status = buildSshStatus({
      appName: "orders-srv",
      sshEnabled: false,
      sshReason: "Disabled for the space",
      now: NOW,
      events: [],
    });
    expect(status.sshEnabled).toBe(false);
    expect(status.sshReason).toBe("Disabled for the space");
    expect(status.activeSessionCount).toBe(0);
  });
});
