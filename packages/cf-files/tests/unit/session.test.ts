import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveApiEndpoint, resolveSessionEnv } from "../../src/session.js";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../../src/cf.js");
});

describe("resolveSessionEnv", () => {
  it("returns credentials from provided env", () => {
    expect(
      resolveSessionEnv({ SAP_EMAIL: "user@example.com", SAP_PASSWORD: "secret" }),
    ).toEqual({
      email: "user@example.com",
      password: "secret",
    });
  });

  it("falls back to process.env when no env passed", () => {
    const saved = { email: process.env["SAP_EMAIL"], password: process.env["SAP_PASSWORD"] };
    process.env["SAP_EMAIL"] = "proc@example.com";
    process.env["SAP_PASSWORD"] = "proc-secret";
    try {
      expect(resolveSessionEnv()).toEqual({
        email: "proc@example.com",
        password: "proc-secret",
      });
    } finally {
      if (saved.email === undefined) {
        delete process.env["SAP_EMAIL"];
      } else {
        process.env["SAP_EMAIL"] = saved.email;
      }
      if (saved.password === undefined) {
        delete process.env["SAP_PASSWORD"];
      } else {
        process.env["SAP_PASSWORD"] = saved.password;
      }
    }
  });

  it("throws when SAP_EMAIL is missing", () => {
    expect(() => resolveSessionEnv({ SAP_PASSWORD: "x" })).toThrow(/SAP_EMAIL/);
  });

  it("throws when SAP_EMAIL is empty", () => {
    expect(() => resolveSessionEnv({ SAP_EMAIL: "", SAP_PASSWORD: "x" })).toThrow(/SAP_EMAIL/);
  });

  it("throws when SAP_PASSWORD is missing", () => {
    expect(() => resolveSessionEnv({ SAP_EMAIL: "a@b.com" })).toThrow(/SAP_PASSWORD/);
  });

  it("throws when SAP_PASSWORD is empty", () => {
    expect(() => resolveSessionEnv({ SAP_EMAIL: "a@b.com", SAP_PASSWORD: "" })).toThrow(
      /SAP_PASSWORD/,
    );
  });
});

describe("resolveApiEndpoint", () => {
  it("returns the endpoint for known regions", () => {
    expect(resolveApiEndpoint("ap10")).toContain("ap10.hana.ondemand.com");
    expect(resolveApiEndpoint("eu10")).toContain("eu10.hana.ondemand.com");
  });

  it("throws for unknown region keys", () => {
    expect(() => resolveApiEndpoint("xx99")).toThrow(/Unknown CF region: xx99/);
  });
});

describe("openCfSession", () => {
  it("runs cf api, cf auth, cf target in order", async () => {
    const calls: string[] = [];
    const receivedCfHomes: string[] = [];

    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn(async (endpoint: string, context: { readonly env?: NodeJS.ProcessEnv }) => {
        receivedCfHomes.push(context.env?.["CF_HOME"] ?? "");
        calls.push(`api:${endpoint}`);
      }),
      cfAuth: vi.fn(async (email: string, password: string, context: { readonly env?: NodeJS.ProcessEnv }) => {
        receivedCfHomes.push(context.env?.["CF_HOME"] ?? "");
        calls.push(`auth:${email}:${password}`);
      }),
      cfTargetSpace: vi.fn(async (org: string, space: string, context: { readonly env?: NodeJS.ProcessEnv }) => {
        receivedCfHomes.push(context.env?.["CF_HOME"] ?? "");
        calls.push(`target:${org}:${space}`);
      }),
    }));

    const { openCfSession } = await import("../../src/session.js");
    const session = await openCfSession(
      { region: "ap10", org: "demo-org", space: "dev", app: "demo-app" },
      { env: { SAP_EMAIL: "u@x.com", SAP_PASSWORD: "p", CF_HOME: "/tmp/cf-files-test-home" } },
    );
    await session.dispose();

    expect(calls).toEqual([
      "api:https://api.cf.ap10.hana.ondemand.com",
      "auth:u@x.com:p",
      "target:demo-org:dev",
    ]);
    expect(receivedCfHomes).toEqual([
      "/tmp/cf-files-test-home",
      "/tmp/cf-files-test-home",
      "/tmp/cf-files-test-home",
    ]);
    expect(session.context.env?.["CF_HOME"]).toBe("/tmp/cf-files-test-home");
    expect(session.context.env?.["SAP_EMAIL"]).toBeUndefined();
    expect(session.context.env?.["SAP_PASSWORD"]).toBeUndefined();
  });

  it("creates an isolated CF_HOME when none is provided", async () => {
    const receivedCfHomes: string[] = [];

    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn(async (_endpoint: string, context: { readonly env?: NodeJS.ProcessEnv }) => {
        receivedCfHomes.push(context.env?.["CF_HOME"] ?? "");
      }),
      cfAuth: vi.fn(async (_email: string, _password: string, context: { readonly env?: NodeJS.ProcessEnv }) => {
        receivedCfHomes.push(context.env?.["CF_HOME"] ?? "");
      }),
      cfTargetSpace: vi.fn(async (_org: string, _space: string, context: { readonly env?: NodeJS.ProcessEnv }) => {
        receivedCfHomes.push(context.env?.["CF_HOME"] ?? "");
      }),
    }));

    const { openCfSession } = await import("../../src/session.js");
    const session = await openCfSession(
      { region: "ap10", org: "demo-org", space: "dev", app: "demo-app" },
      { env: { SAP_EMAIL: "u@x.com", SAP_PASSWORD: "p" } },
    );

    expect(session.context.env?.["CF_HOME"]).toContain("saptools-cf-files-");
    expect(new Set(receivedCfHomes)).toEqual(new Set([session.context.env?.["CF_HOME"]]));
    await session.dispose();
  });

  it("refuses to run when credentials are missing", async () => {
    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn(),
      cfAuth: vi.fn(),
      cfTargetSpace: vi.fn(),
    }));

    const { openCfSession } = await import("../../src/session.js");
    await expect(
      openCfSession(
        { region: "ap10", org: "demo-org", space: "dev", app: "demo-app" },
        { env: {} },
      ),
    ).rejects.toThrow(/SAP_EMAIL/);
  });

  it("refuses to run for unknown region", async () => {
    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn(),
      cfAuth: vi.fn(),
      cfTargetSpace: vi.fn(),
    }));

    const { openCfSession } = await import("../../src/session.js");
    await expect(
      openCfSession(
        { region: "unknown", org: "o", space: "s", app: "a" },
        { env: { SAP_EMAIL: "u@x.com", SAP_PASSWORD: "p" } },
      ),
    ).rejects.toThrow(/Unknown CF region/);
  });
});
