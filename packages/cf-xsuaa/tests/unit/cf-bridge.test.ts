import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppRef } from "../../src/types.js";

const originalEnv = { ...process.env };
const ref: AppRef = { region: "ap10", org: "org", space: "space", app: "app" };

function sampleEnvOutput(url = "https://uaa.example.com"): string {
  return [
    "System-Provided:",
    `VCAP_SERVICES: ${JSON.stringify({
      xsuaa: [
        {
          credentials: {
            clientid: "client-id",
            clientsecret: "client-secret",
            url,
            xsappname: "app-name",
          },
        },
      ],
    })}`,
    "VCAP_APPLICATION: {}",
  ].join("\n");
}

function mockCfSync(options: { readonly envOutput?: string; readonly authError?: Error } = {}): {
  readonly calls: string[];
  readonly cfApi: ReturnType<typeof vi.fn<(apiEndpoint: string) => Promise<void>>>;
  readonly cfAuth: ReturnType<typeof vi.fn<(email: string, password: string) => Promise<void>>>;
  readonly cfTargetSpace: ReturnType<typeof vi.fn<(org: string, space: string) => Promise<void>>>;
  readonly cfEnv: ReturnType<typeof vi.fn<(appName: string) => Promise<string>>>;
} {
  const calls: string[] = [];
  const cfApi = vi.fn<(apiEndpoint: string) => Promise<void>>(async (apiEndpoint) => {
    calls.push(`api:${apiEndpoint}`);
  });
  const cfAuth = vi.fn<(email: string, password: string) => Promise<void>>(async (email, password) => {
    calls.push(`auth:${email}:${password.length.toString()}`);
    if (options.authError) {
      throw options.authError;
    }
  });
  const cfTargetSpace = vi.fn<(org: string, space: string) => Promise<void>>(async (org, space) => {
    calls.push(`target:${org}:${space}`);
  });
  const cfEnv = vi.fn<(appName: string) => Promise<string>>(async (appName) => {
    calls.push(`env:${appName}`);
    return options.envOutput ?? sampleEnvOutput();
  });

  vi.doMock("@saptools/cf-sync", () => ({
    REGION_KEYS: ["ap10"],
    cfApi,
    cfAuth,
    cfEnv,
    cfTargetSpace,
    getRegion: (key: string) => ({
      key,
      label: "Region",
      apiEndpoint: `https://api.${key}.example.com`,
    }),
  }));

  return { calls, cfApi, cfAuth, cfTargetSpace, cfEnv };
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("@saptools/cf-sync");
  process.env = { ...originalEnv, SAP_EMAIL: "user@example.com", SAP_PASSWORD: "password" };
});

describe("fetchAppXsuaaCredentials", () => {
  it("rejects unknown regions before calling CF", async () => {
    const mocked = mockCfSync();
    const { fetchAppXsuaaCredentials } = await import("../../src/cloud-foundry/xsuaa.js");

    await expect(fetchAppXsuaaCredentials({ ...ref, region: "unknown" })).rejects.toThrow(/Unknown region/);

    expect(mocked.cfApi).not.toHaveBeenCalled();
    expect(mocked.cfAuth).not.toHaveBeenCalled();
    expect(mocked.cfTargetSpace).not.toHaveBeenCalled();
    expect(mocked.cfEnv).not.toHaveBeenCalled();
  });

  it("requires SAP_EMAIL before CF authentication", async () => {
    delete process.env["SAP_EMAIL"];
    const mocked = mockCfSync();
    const { fetchAppXsuaaCredentials } = await import("../../src/cloud-foundry/xsuaa.js");

    await expect(fetchAppXsuaaCredentials(ref)).rejects.toThrow(/SAP_EMAIL/);

    expect(mocked.cfApi).not.toHaveBeenCalled();
    expect(mocked.cfAuth).not.toHaveBeenCalled();
  });

  it("requires SAP_PASSWORD before CF authentication", async () => {
    delete process.env["SAP_PASSWORD"];
    const mocked = mockCfSync();
    const { fetchAppXsuaaCredentials } = await import("../../src/cloud-foundry/xsuaa.js");

    await expect(fetchAppXsuaaCredentials(ref)).rejects.toThrow(/SAP_PASSWORD/);

    expect(mocked.cfApi).not.toHaveBeenCalled();
    expect(mocked.cfAuth).not.toHaveBeenCalled();
  });

  it("targets CF and parses credentials in order", async () => {
    const mocked = mockCfSync();
    const { fetchAppXsuaaCredentials } = await import("../../src/cloud-foundry/xsuaa.js");

    const credentials = await fetchAppXsuaaCredentials(ref);

    expect(credentials).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      url: "https://uaa.example.com",
      xsappname: "app-name",
    });
    expect(mocked.calls).toEqual([
      "api:https://api.ap10.example.com",
      "auth:user@example.com:8",
      "target:org:space",
      "env:app",
    ]);
  });

  it("propagates parser failures from CF env output", async () => {
    mockCfSync({ envOutput: "System-Provided:\nVCAP_SERVICES: {}\nVCAP_APPLICATION: {}" });
    const { fetchAppXsuaaCredentials } = await import("../../src/cloud-foundry/xsuaa.js");

    await expect(fetchAppXsuaaCredentials(ref)).rejects.toThrow(/xsuaa/);
  });

  it("propagates sanitized auth failures without exposing the password", async () => {
    mockCfSync({ authError: new Error("cf auth failed: [REDACTED]") });
    const { fetchAppXsuaaCredentials } = await import("../../src/cloud-foundry/xsuaa.js");

    await expect(fetchAppXsuaaCredentials(ref)).rejects.not.toThrow(/password/);
    await expect(fetchAppXsuaaCredentials(ref)).rejects.toThrow(/\[REDACTED]/);
  });
});
