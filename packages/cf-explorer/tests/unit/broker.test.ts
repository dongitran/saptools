import { describe, expect, it } from "vitest";

import { parseBrokerBootstrap } from "../../src/broker/bootstrap.js";
import { runBrokerFromEnv } from "../../src/broker.js";

describe("broker bootstrap", () => {
  it("validates and normalizes broker bootstrap payloads", () => {
    const parsed = parseBrokerBootstrap(JSON.stringify({
      sessionId: "session-a",
      homeDir: "/tmp/cf-explorer-test",
      target: {
        region: " ap10 ",
        org: " org ",
        space: " dev ",
        app: " demo-app ",
        apiEndpoint: " https://api.example.test ",
      },
      process: " worker ",
      instance: 2,
      cfBin: "/tmp/fake-cf.mjs",
      idleTimeoutMs: 1000,
      maxLifetimeMs: 2000,
    }));

    expect(parsed).toEqual({
      sessionId: "session-a",
      homeDir: "/tmp/cf-explorer-test",
      target: {
        region: "ap10",
        org: "org",
        space: "dev",
        app: "demo-app",
        apiEndpoint: "https://api.example.test",
      },
      process: "worker",
      instance: 2,
      cfBin: "/tmp/fake-cf.mjs",
      idleTimeoutMs: 1000,
      maxLifetimeMs: 2000,
    });
  });

  it("normalizes malformed bootstrap JSON into typed broker errors", async () => {
    await expect(runBrokerFromEnv({
      CF_EXPLORER_BROKER_BOOTSTRAP: "not-json",
    })).rejects.toMatchObject({
      code: "BROKER_UNAVAILABLE",
      message: "Invalid broker bootstrap payload.",
    });
  });

  it("rejects invalid bootstrap fields before session startup", async () => {
    const payload = {
      sessionId: "session-a",
      homeDir: "/tmp/cf-explorer-test",
      target: { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      process: "",
      instance: 0,
    };

    await expect(runBrokerFromEnv({
      CF_EXPLORER_BROKER_BOOTSTRAP: JSON.stringify(payload),
    })).rejects.toMatchObject({
      code: "BROKER_UNAVAILABLE",
      message: expect.stringContaining("process is required"),
    });
  });

  it("rejects invalid bootstrap target and numeric fields", () => {
    const basePayload = {
      sessionId: "session-a",
      homeDir: "/tmp/cf-explorer-test",
      target: { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      process: "web",
      instance: 0,
    };

    expect(() => parseBrokerBootstrap(JSON.stringify({
      ...basePayload,
      target: { ...basePayload.target, apiEndpoint: 42 },
    }))).toThrow(/apiEndpoint/);
    expect(() => parseBrokerBootstrap(JSON.stringify({
      ...basePayload,
      instance: -1,
    }))).toThrow(/Instance/);
    expect(() => parseBrokerBootstrap(JSON.stringify({
      ...basePayload,
      idleTimeoutMs: 0,
    }))).toThrow(/idleTimeoutMs/);
  });
});
