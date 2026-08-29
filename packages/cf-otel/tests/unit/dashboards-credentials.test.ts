import { afterEach, describe, expect, it, vi } from "vitest";

import * as cf from "../../src/cf.js";
import { discoverDashboardsCredential } from "../../src/dashboards-credentials.js";
import { CredentialsNotFoundError } from "../../src/errors.js";
import * as samlToggle from "../../src/saml-toggle.js";
import type { DashboardsCredential, ResolvedTarget } from "../../src/types.js";

vi.mock("../../src/saml-toggle.js", () => ({ mintDashboardsCredential: vi.fn() }));

const TARGET: ResolvedTarget = {
  apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
  region: "eu10",
  org: "example-org",
  space: "space-demo",
  selectorSource: "explicit",
  regionConfirmed: true,
};
const SAP = { email: "user@example.com", password: "sap-password" };

function stubLogin(): void {
  vi.spyOn(cf, "withCfSession").mockImplementation(async (work) => await work({ cfHome: "/tmp/fake" }));
  vi.spyOn(cf, "cfApi").mockResolvedValue(undefined);
  vi.spyOn(cf, "cfAuth").mockResolvedValue(undefined);
  vi.spyOn(cf, "cfTargetSpace").mockResolvedValue(undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("discoverDashboardsCredential", () => {
  it("succeeds on the first service key when it has real dashboards credentials", async () => {
    stubLogin();
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue(
      '{"dashboards-endpoint":"https://dash.example.com","dashboards-username":"u","dashboards-password":"real-secret-1"}',
    );

    const credential = await discoverDashboardsCredential(TARGET, SAP, {
      serviceInstance: "cloud-logging",
      serviceKeyNames: ["key1"],
      fallbackBindingApps: [],
      allowMintCredential: false,
      verbose: false,
    });

    expect(credential).toMatchObject({
      dashboardsEndpoint: "https://dash.example.com",
      username: "u",
      password: "real-secret-1",
      source: "service-key:key1",
    });
  });

  it("falls through to a later key on the same instance when the first key lacks dashboards fields", async () => {
    stubLogin();
    vi.spyOn(cf, "cfServiceKey").mockImplementation(async (_instance: string, keyName: string) => {
      if (keyName === "key1") {
        return '{"some-other-field": "x"}';
      }
      return '{"dashboards-endpoint":"https://dash.example.com","dashboards-username":"u","dashboards-password":"real-secret-2"}';
    });

    const credential = await discoverDashboardsCredential(TARGET, SAP, {
      serviceInstance: "cloud-logging",
      serviceKeyNames: ["key1", "key2"],
      fallbackBindingApps: [],
      allowMintCredential: false,
      verbose: false,
    });

    expect(credential.source).toBe("service-key:key2");
    expect(credential.password).toBe("real-secret-2");
  });

  it("falls back to a pre-SAML app binding when every service key fails", async () => {
    stubLogin();
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue('{"no-dashboards-here": true}');
    vi.spyOn(cf, "cfEnv").mockResolvedValue(
      "VCAP_SERVICES:\n" +
        '{"cloud-logging":[{"name":"cloud-logging","credentials":{"dashboards-endpoint":"https://dash.example.com",' +
        '"dashboards-username":"u","dashboards-password":"real-secret-3"}}]}\n' +
        "VCAP_APPLICATION:{}",
    );

    const credential = await discoverDashboardsCredential(TARGET, SAP, {
      serviceInstance: "cloud-logging",
      serviceKeyNames: ["key1"],
      fallbackBindingApps: ["legacy-app"],
      allowMintCredential: false,
      verbose: false,
    });

    expect(credential.source).toBe("fallback-binding:legacy-app");
    expect(credential.password).toBe("real-secret-3");
  });

  it("finds a fallback binding via instance_name when the binding itself has a custom name", async () => {
    // A real VCAP_SERVICES entry's "name" is the *binding* name, which only
    // equals the service instance name when no custom --binding-name was
    // used; "instance_name" (when present) is the authoritative one.
    stubLogin();
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue('{"no-dashboards-here": true}');
    vi.spyOn(cf, "cfEnv").mockResolvedValue(
      "VCAP_SERVICES:\n" +
        '{"cloud-logging":[{"name":"my-custom-binding","instance_name":"cloud-logging","credentials":' +
        '{"dashboards-endpoint":"https://dash.example.com","dashboards-username":"u","dashboards-password":"real-secret-4"}}]}\n' +
        "VCAP_APPLICATION:{}",
    );

    const credential = await discoverDashboardsCredential(TARGET, SAP, {
      serviceInstance: "cloud-logging",
      serviceKeyNames: ["key1"],
      fallbackBindingApps: ["legacy-app"],
      allowMintCredential: false,
      verbose: false,
    });

    expect(credential.source).toBe("fallback-binding:legacy-app");
    expect(credential.password).toBe("real-secret-4");
  });

  it("fails with one message naming every attempted key and binding when everything fails and minting is not allowed", async () => {
    stubLogin();
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue('{"no-dashboards-here": true}');
    vi.spyOn(cf, "cfEnv").mockRejectedValue(new Error("app not found"));

    const options = {
      serviceInstance: "cloud-logging",
      serviceKeyNames: ["key1", "key2"],
      fallbackBindingApps: ["legacy-app"],
      allowMintCredential: false,
      verbose: false,
    };

    await expect(discoverDashboardsCredential(TARGET, SAP, options)).rejects.toThrow(CredentialsNotFoundError);

    const caught: unknown = await discoverDashboardsCredential(TARGET, SAP, options).catch((error: unknown) => error);
    const message = (caught as Error).message;
    expect(message).toContain('service key "key1"');
    expect(message).toContain('service key "key2"');
    expect(message).toContain('fallback binding app "legacy-app"');
    expect(message).toContain("--allow-mint-credential");
  });

  it("delegates to mintDashboardsCredential only when --allow-mint-credential is set", async () => {
    stubLogin();
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue('{"no-dashboards-here": true}');
    vi.spyOn(cf, "cfEnv").mockRejectedValue(new Error("app not found"));
    const mintedCredential: DashboardsCredential = {
      dashboardsEndpoint: "https://dash.example.com",
      username: "u",
      password: "minted-secret",
      source: "minted:key",
    };
    vi.mocked(samlToggle.mintDashboardsCredential).mockResolvedValue(mintedCredential);

    const credential = await discoverDashboardsCredential(TARGET, SAP, {
      serviceInstance: "cloud-logging",
      serviceKeyNames: ["key1"],
      fallbackBindingApps: [],
      allowMintCredential: true,
      verbose: false,
    });

    expect(credential).toEqual(mintedCredential);
    expect(samlToggle.mintDashboardsCredential).toHaveBeenCalledWith("cloud-logging", { cfHome: "/tmp/fake" }, {
      confirmDisruptive: true,
      report: expect.any(Function),
    });
  });

  it("does not attempt to mint when --allow-mint-credential is not set", async () => {
    stubLogin();
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue('{"no-dashboards-here": true}');
    vi.spyOn(cf, "cfEnv").mockRejectedValue(new Error("app not found"));

    await expect(
      discoverDashboardsCredential(TARGET, SAP, {
        serviceInstance: "cloud-logging",
        serviceKeyNames: ["key1"],
        fallbackBindingApps: [],
        allowMintCredential: false,
        verbose: false,
      }),
    ).rejects.toThrow(CredentialsNotFoundError);
    expect(samlToggle.mintDashboardsCredential).not.toHaveBeenCalled();
  });

  it("never leaks the resolved password into any captured stdout/stderr output, even with --verbose", async () => {
    stubLogin();
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue(
      '{"dashboards-endpoint":"https://dash.example.com","dashboards-username":"u","dashboards-password":"super-secret-password"}',
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await discoverDashboardsCredential(TARGET, SAP, {
      serviceInstance: "cloud-logging",
      serviceKeyNames: ["key1"],
      fallbackBindingApps: [],
      allowMintCredential: false,
      verbose: true,
    });

    const allOutput = [...stderrSpy.mock.calls, ...stdoutSpy.mock.calls].map((call) => String(call[0])).join("\n");
    expect(allOutput).not.toContain("super-secret-password");
  });
});
