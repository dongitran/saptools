import { afterEach, describe, expect, it, vi } from "vitest";

import { withOpenSearchClient } from "../../src/cli/client-bootstrap.js";
import * as dashboardsCredentials from "../../src/dashboards-credentials.js";
import { CredentialsNotFoundError } from "../../src/errors.js";
import * as target from "../../src/target.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const BASE_OPTS = {
  region: "eu10",
  org: "o",
  space: "s",
  serviceKey: [],
  fallbackBindingApp: [],
  allowMintCredential: false,
  verbose: false,
};

describe("withOpenSearchClient", () => {
  it("resolves target, requires SAP_EMAIL/SAP_PASSWORD, and hands the caller a working client", async () => {
    vi.spyOn(target, "resolveTarget").mockResolvedValue({
      apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
      region: "eu10",
      org: "o",
      space: "s",
      selectorSource: "explicit",
      regionConfirmed: true,
    });
    vi.spyOn(target, "printResolvedTarget").mockImplementation(() => undefined);
    vi.stubEnv("SAP_EMAIL", "user@example.com");
    vi.stubEnv("SAP_PASSWORD", "pw");
    vi.spyOn(dashboardsCredentials, "discoverDashboardsCredential").mockResolvedValue({
      dashboardsEndpoint: "https://dash.example.com",
      username: "u",
      password: "p",
      source: "service-key:key1",
    });

    const result = await withOpenSearchClient(BASE_OPTS, async (client) => {
      expect(client).toBeDefined();
      return "ok";
    });

    expect(result).toBe("ok");
  });

  it("fails clearly when SAP_EMAIL/SAP_PASSWORD are not set", async () => {
    vi.spyOn(target, "resolveTarget").mockResolvedValue({
      apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
      region: "eu10",
      org: "o",
      space: "s",
      selectorSource: "explicit",
      regionConfirmed: true,
    });
    vi.spyOn(target, "printResolvedTarget").mockImplementation(() => undefined);
    vi.stubEnv("SAP_EMAIL", "");
    vi.stubEnv("SAP_PASSWORD", "");

    await expect(withOpenSearchClient(BASE_OPTS, async () => "unreachable")).rejects.toBeInstanceOf(CredentialsNotFoundError);
  });

  it("forwards optional serviceInstance/serviceKey/fallbackBindingApp only when provided", async () => {
    vi.spyOn(target, "resolveTarget").mockResolvedValue({
      apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
      region: "eu10",
      org: "o",
      space: "s",
      selectorSource: "explicit",
      regionConfirmed: true,
    });
    vi.spyOn(target, "printResolvedTarget").mockImplementation(() => undefined);
    vi.stubEnv("SAP_EMAIL", "user@example.com");
    vi.stubEnv("SAP_PASSWORD", "pw");
    const discover = vi.spyOn(dashboardsCredentials, "discoverDashboardsCredential").mockResolvedValue({
      dashboardsEndpoint: "https://dash.example.com",
      username: "u",
      password: "p",
      source: "service-key:key1",
    });

    await withOpenSearchClient(
      { ...BASE_OPTS, serviceInstance: "cloud-logging", serviceKey: ["key1"], fallbackBindingApp: ["app1"] },
      async () => undefined,
    );

    expect(discover).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ serviceInstance: "cloud-logging", serviceKeyNames: ["key1"], fallbackBindingApps: ["app1"] }),
    );
  });
});
