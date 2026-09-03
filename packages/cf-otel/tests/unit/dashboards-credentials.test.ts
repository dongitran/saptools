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

  it("resolves a service key whose payload uses CF CLI v8's credentials wrapper", async () => {
    // The shape a real `cf service-key` returns on CLI v8. Reading only the
    // top level made --service-key resolve nothing at all, and the reported
    // reason ("payload had no dashboards-username/dashboards-password") sent
    // the reader looking for a SAML problem that did not exist.
    stubLogin();
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue(
      '{\n  "credentials": {\n    "dashboards-endpoint": "https://dash.example.com",\n' +
        '    "dashboards-username": "u",\n    "dashboards-password": "real-secret-v8"\n  }\n}',
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
      password: "real-secret-v8",
      source: "service-key:key1",
    });
  });

  it("discovers key names from the CF CLI v8 service-keys table, newest listed first", async () => {
    // parseServiceKeyNames feeds this path when --service-key is not passed:
    // on the v8 three-column table it used to return nothing, so discovery
    // reported "no service keys exist" and skipped straight to the per-app
    // `cf env` scan even on an instance that had usable keys.
    stubLogin();
    vi.spyOn(cf, "cfServiceKeys").mockResolvedValue(
      [
        "Getting keys for service instance cloud-logging as user@example.com...",
        "",
        "name   last operation     message",
        "key1   create succeeded   ",
        "key2   create succeeded   ",
      ].join("\n"),
    );
    const serviceKey = vi.spyOn(cf, "cfServiceKey").mockResolvedValue(
      '{"credentials":{"dashboards-endpoint":"https://dash.example.com","dashboards-username":"u","dashboards-password":"pw"}}',
    );

    const credential = await discoverDashboardsCredential(TARGET, SAP, {
      serviceInstance: "cloud-logging",
      fallbackBindingApps: [],
      allowMintCredential: false,
      verbose: false,
    });

    expect(credential.source).toBe("service-key:key2");
    expect(serviceKey).toHaveBeenCalledWith("cloud-logging", "key2", { cfHome: "/tmp/fake" });
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

/**
 * `cf services` is the single most expensive command in the discovery path:
 * the CF CLI implements it as one request per instance in the space, measured
 * at 11.8s and 15.9s in one traced cold run on a real tenant. It used to run
 * twice, because instance discovery returned only the instance's name and the
 * fallback-binding step then re-fetched the whole listing to read that same
 * row's bound apps back.
 */
describe("discoverDashboardsCredential: how often `cf services` runs", () => {
  // `cf services` pads every column to a fixed width, so build rows from those
  // widths rather than hand-aligning spaces.
  function servicesRow(name: string, offering: string, plan: string, boundApps: string, lastOp: string): string {
    return name.padEnd(17) + offering.padEnd(16) + plan.padEnd(11) + boundApps.padEnd(20) + lastOp;
  }

  function servicesStdout(boundApps: string): string {
    return [
      servicesRow("name", "offering", "plan", "bound apps", "last operation"),
      servicesRow("cloud-logging", "cloud-logging", "standard", boundApps, "create succeeded"),
      servicesRow("other-service", "xsuaa", "broker", "some-app", "create succeeded"),
    ].join("\n");
  }

  const NO_KEYS = "Getting keys for service instance cloud-logging as user@example.com...\n\nNo service keys for service instance cloud-logging";
  const WORKING_VCAP =
    "VCAP_SERVICES:\n" +
    '{"cloud-logging":[{"name":"cloud-logging","credentials":{"dashboards-endpoint":"https://dash.example.com",' +
    '"dashboards-username":"u","dashboards-password":"pw"}}]}\n' +
    "VCAP_APPLICATION:{}";

  function stubNoUsableKeys(): void {
    vi.spyOn(cf, "cfServiceKeys").mockResolvedValue(NO_KEYS);
  }

  it("runs exactly once when auto-discovering and then falling back to a bound app", async () => {
    // The common case on a SAML-enabled instance: no usable service key, so the
    // fallback-binding step runs -- and it must not re-list the services.
    stubLogin();
    stubNoUsableKeys();
    const services = vi.spyOn(cf, "cfServices").mockResolvedValue(servicesStdout("legacy-app"));
    const env = vi.spyOn(cf, "cfEnv").mockResolvedValue(WORKING_VCAP);

    const credential = await discoverDashboardsCredential(TARGET, SAP, {
      allowMintCredential: false,
      verbose: false,
    });

    expect(credential.source).toBe("fallback-binding:legacy-app");
    expect(services).toHaveBeenCalledTimes(1);
    expect(env).toHaveBeenCalledWith("legacy-app", { cfHome: "/tmp/fake" });
  });

  it("runs exactly once when a service key succeeds and the fallback is never reached", async () => {
    stubLogin();
    vi.spyOn(cf, "cfServiceKeys").mockResolvedValue(
      ["name   last operation     message", "key1   create succeeded   "].join("\n"),
    );
    vi.spyOn(cf, "cfServiceKey").mockResolvedValue(
      '{"credentials":{"dashboards-endpoint":"https://dash.example.com","dashboards-username":"u","dashboards-password":"pw"}}',
    );
    const services = vi.spyOn(cf, "cfServices").mockResolvedValue(servicesStdout("legacy-app"));
    const env = vi.spyOn(cf, "cfEnv");

    const credential = await discoverDashboardsCredential(TARGET, SAP, {
      allowMintCredential: false,
      verbose: false,
    });

    expect(credential.source).toBe("service-key:key1");
    expect(services).toHaveBeenCalledTimes(1);
    expect(env).not.toHaveBeenCalled();
  });

  it("does not list a second time for an auto-discovered instance that has no bound apps", async () => {
    // An empty bound-apps cell yields `[]`, which is a real answer and must not
    // be mistaken for "not fetched yet".
    stubLogin();
    stubNoUsableKeys();
    const services = vi.spyOn(cf, "cfServices").mockResolvedValue(servicesStdout(""));
    const env = vi.spyOn(cf, "cfEnv");

    const caught: unknown = await discoverDashboardsCredential(TARGET, SAP, {
      allowMintCredential: false,
      verbose: false,
    }).catch((error: unknown) => error);

    expect((caught as Error).message).toContain("no apps are bound to instance");
    expect(services).toHaveBeenCalledTimes(1);
    expect(env).not.toHaveBeenCalled();
  });

  it("runs exactly once when the instance is pinned but the fallback apps are not", async () => {
    // Nothing has listed the services on this path, so `findBoundApps` still
    // has to -- once.
    stubLogin();
    stubNoUsableKeys();
    const services = vi.spyOn(cf, "cfServices").mockResolvedValue(servicesStdout("legacy-app"));
    vi.spyOn(cf, "cfEnv").mockResolvedValue(WORKING_VCAP);

    const credential = await discoverDashboardsCredential(TARGET, SAP, {
      serviceInstance: "cloud-logging",
      allowMintCredential: false,
      verbose: false,
    });

    expect(credential.source).toBe("fallback-binding:legacy-app");
    expect(services).toHaveBeenCalledTimes(1);
  });

  it("never runs when both the instance and the fallback apps are pinned", async () => {
    stubLogin();
    stubNoUsableKeys();
    const services = vi.spyOn(cf, "cfServices");
    vi.spyOn(cf, "cfEnv").mockResolvedValue(WORKING_VCAP);

    const credential = await discoverDashboardsCredential(TARGET, SAP, {
      serviceInstance: "cloud-logging",
      fallbackBindingApps: ["legacy-app"],
      allowMintCredential: false,
      verbose: false,
    });

    expect(credential.source).toBe("fallback-binding:legacy-app");
    expect(services).not.toHaveBeenCalled();
  });
});
