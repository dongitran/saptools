/* eslint-disable @typescript-eslint/unbound-method */
import { describe, expect, it, vi } from "vitest";

import { discoverDashboardsCredential, discoverServiceInstance } from "../../../src/cloud-logging/dashboards-credentials.js";
import type { CloudLoggingCfExecutor } from "../../../src/cloud-logging/types.js";

const TARGET = { apiEndpoint: "e", region: "br10", org: "o", space: "s", selectorSource: "explicit" as const, regionConfirmed: true };

function jsonResponse(payload: unknown): string {
  return JSON.stringify(payload);
}

const INSTANCES_PAGE = jsonResponse({
  pagination: { total_pages: 1 },
  resources: [{ guid: "inst-1", name: "cloud-logging", relationships: { service_plan: { data: { guid: "plan-1" } } } }],
  included: {
    service_plans: [{ guid: "plan-1", relationships: { service_offering: { data: { guid: "off-1" } } } }],
    service_offerings: [{ guid: "off-1", name: "cloud-logging" }],
  },
});

function fakeExecutor(overrides: Partial<CloudLoggingCfExecutor> = {}): CloudLoggingCfExecutor {
   
  return {
    ambientContext: {},
    cfCurl: vi.fn(async () => "{}") as CloudLoggingCfExecutor["cfCurl"],
    cfServiceGuid: vi.fn(async () => "inst-1") as CloudLoggingCfExecutor["cfServiceGuid"],
    cfSpaceGuid: vi.fn(async () => "space-1") as CloudLoggingCfExecutor["cfSpaceGuid"],
    isCfAuthFailure: vi.fn(() => false) as CloudLoggingCfExecutor["isCfAuthFailure"],
     
    withCfSession: vi.fn(async (work) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return await work({});
    }) as CloudLoggingCfExecutor["withCfSession"],
    cfApi: vi.fn() as CloudLoggingCfExecutor["cfApi"],
    cfAuth: vi.fn() as CloudLoggingCfExecutor["cfAuth"],
    cfTargetSpace: vi.fn() as CloudLoggingCfExecutor["cfTargetSpace"],
    readCurrentCfTarget: vi.fn(async () => undefined) as CloudLoggingCfExecutor["readCurrentCfTarget"],
    getApiEndpointForRegion: vi.fn(() => undefined) as CloudLoggingCfExecutor["getApiEndpointForRegion"],
    ...overrides,
  };
}

describe("discoverServiceInstance", () => {
  it("returns the single cloud-logging instance in the space", async () => {
    const executor = fakeExecutor({ cfCurl: vi.fn(async () => INSTANCES_PAGE) });
    const instance = await discoverServiceInstance(TARGET, executor);
    expect(instance).toEqual({ name: "cloud-logging", guid: "inst-1" });
  });

  it("fails closed with a clear message when there are zero cloud-logging instances", async () => {
    const executor = fakeExecutor({ cfCurl: vi.fn(async () => jsonResponse({ pagination: { total_pages: 1 }, resources: [], included: {} })) });
    await expect(discoverServiceInstance(TARGET, executor)).rejects.toThrow(/No "cloud-logging" service instance/);
  });

  it("fails closed with a clear message when there are multiple cloud-logging instances", async () => {
    const twoInstances = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [
        { guid: "inst-1", name: "cloud-logging", relationships: { service_plan: { data: { guid: "plan-1" } } } },
        { guid: "inst-2", name: "cloud-logging-2", relationships: { service_plan: { data: { guid: "plan-1" } } } },
      ],
      included: { service_plans: [{ guid: "plan-1", relationships: { service_offering: { data: { guid: "off-1" } } } }], service_offerings: [{ guid: "off-1", name: "cloud-logging" }] },
    });
    const executor = fakeExecutor({ cfCurl: vi.fn(async () => twoInstances) });
    await expect(discoverServiceInstance(TARGET, executor)).rejects.toThrow(/Multiple "cloud-logging" service instances/);
  });

  it("handles paginated results correctly", async () => {
    const page1 = jsonResponse({
      pagination: { total_pages: 2 },
      resources: [{ guid: "inst-1", name: "cloud-logging", relationships: { service_plan: { data: { guid: "plan-1" } } } }],
      included: { service_plans: [{ guid: "plan-1", relationships: { service_offering: { data: { guid: "off-1" } } } }], service_offerings: [{ guid: "off-1", name: "cloud-logging" }] },
    });
    const page2 = jsonResponse({
      pagination: { total_pages: 2 },
      resources: [],
      included: { service_plans: [], service_offerings: [] },
    });
    let pageNum = 0;
    const executor = fakeExecutor({
      cfCurl: vi.fn(async () => {
        pageNum += 1;
        return pageNum === 1 ? page1 : page2;
      }),
    });
    const instance = await discoverServiceInstance(TARGET, executor);
    expect(instance).toEqual({ name: "cloud-logging", guid: "inst-1" });
    expect(executor.cfCurl).toHaveBeenCalledTimes(2);
  });

  it("filters instances by offering name", async () => {
    const mixedInstances = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [
        { guid: "inst-1", name: "cloud-logging", relationships: { service_plan: { data: { guid: "plan-1" } } } },
        { guid: "inst-2", name: "other-service", relationships: { service_plan: { data: { guid: "plan-2" } } } },
      ],
      included: {
        service_plans: [
          { guid: "plan-1", relationships: { service_offering: { data: { guid: "off-1" } } } },
          { guid: "plan-2", relationships: { service_offering: { data: { guid: "off-2" } } } },
        ],
        service_offerings: [
          { guid: "off-1", name: "cloud-logging" },
          { guid: "off-2", name: "some-other-offering" },
        ],
      },
    });
    const executor = fakeExecutor({ cfCurl: vi.fn(async () => mixedInstances) });
    const instance = await discoverServiceInstance(TARGET, executor);
    expect(instance).toEqual({ name: "cloud-logging", guid: "inst-1" });
  });

  it("skips resources missing name or guid", async () => {
    const incompleteResources = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [
        { guid: "inst-1", relationships: { service_plan: { data: { guid: "plan-1" } } } }, // Missing name
        { name: "cloud-logging", relationships: { service_plan: { data: { guid: "plan-1" } } } }, // Missing guid
        { guid: "inst-3", name: "cloud-logging", relationships: { service_plan: { data: { guid: "plan-1" } } } },
      ],
      included: { service_plans: [{ guid: "plan-1", relationships: { service_offering: { data: { guid: "off-1" } } } }], service_offerings: [{ guid: "off-1", name: "cloud-logging" }] },
    });
    const executor = fakeExecutor({ cfCurl: vi.fn(async () => incompleteResources) });
    const instance = await discoverServiceInstance(TARGET, executor);
    expect(instance).toEqual({ name: "cloud-logging", guid: "inst-3" });
  });

  it("handles pagination with zero total_pages", async () => {
    const response = jsonResponse({
      pagination: { total_pages: 0 },
      resources: [],
      included: { service_plans: [], service_offerings: [] },
    });
    const executor = fakeExecutor({ cfCurl: vi.fn(async () => response) });
    await expect(discoverServiceInstance(TARGET, executor)).rejects.toThrow(/No "cloud-logging" service instance/);
  });

  it("handles pagination with non-numeric total_pages", async () => {
    const response = jsonResponse({
      pagination: { total_pages: "not-a-number" },
      resources: [],
      included: { service_plans: [], service_offerings: [] },
    });
    const executor = fakeExecutor({ cfCurl: vi.fn(async () => response) });
    await expect(discoverServiceInstance(TARGET, executor)).rejects.toThrow(/No "cloud-logging" service instance/);
  });

  it("handles missing pagination information", async () => {
    const response = jsonResponse({
      resources: [{ guid: "inst-1", name: "cloud-logging", relationships: { service_plan: { data: { guid: "plan-1" } } } }],
      included: { service_plans: [{ guid: "plan-1", relationships: { service_offering: { data: { guid: "off-1" } } } }], service_offerings: [{ guid: "off-1", name: "cloud-logging" }] },
    });
    const executor = fakeExecutor({ cfCurl: vi.fn(async () => response) });
    const instance = await discoverServiceInstance(TARGET, executor);
    expect(instance).toEqual({ name: "cloud-logging", guid: "inst-1" });
  });

  it("throws when API response is not a record", async () => {
    const executor = fakeExecutor({ cfCurl: vi.fn(async () => "[]") });
    await expect(discoverServiceInstance(TARGET, executor)).rejects.toThrow(/unexpected shape/);
  });

  it("handles resources with malformed relationships", async () => {
    const response = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [
        { guid: "inst-1", name: "cloud-logging", relationships: null }, // relationships is null
        { guid: "inst-2", name: "cloud-logging", relationships: { service_plan: { data: { guid: "plan-1" } } } },
      ],
      included: { service_plans: [{ guid: "plan-1", relationships: { service_offering: { data: { guid: "off-1" } } } }], service_offerings: [{ guid: "off-1", name: "cloud-logging" }] },
    });
    const executor = fakeExecutor({ cfCurl: vi.fn(async () => response) });
    const instance = await discoverServiceInstance(TARGET, executor);
    expect(instance).toEqual({ name: "cloud-logging", guid: "inst-2" });
  });

  it("handles resources with malformed plan relationship data", async () => {
    const response = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [
        { guid: "inst-1", name: "cloud-logging", relationships: { service_plan: { data: "not-an-object" } } }, // data is not an object
        { guid: "inst-2", name: "cloud-logging", relationships: { service_plan: { data: { guid: "plan-1" } } } },
      ],
      included: { service_plans: [{ guid: "plan-1", relationships: { service_offering: { data: { guid: "off-1" } } } }], service_offerings: [{ guid: "off-1", name: "cloud-logging" }] },
    });
    const executor = fakeExecutor({ cfCurl: vi.fn(async () => response) });
    const instance = await discoverServiceInstance(TARGET, executor);
    expect(instance).toEqual({ name: "cloud-logging", guid: "inst-2" });
  });

  it("handles missing included section", async () => {
    const response = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [{ guid: "inst-1", name: "cloud-logging", relationships: { service_plan: { data: { guid: "plan-1" } } } }],
    });
    const executor = fakeExecutor({ cfCurl: vi.fn(async () => response) });
    await expect(discoverServiceInstance(TARGET, executor)).rejects.toThrow(/No "cloud-logging" service instance/);
  });

  it("handles plans without offering relationship", async () => {
    const response = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [
        { guid: "inst-1", name: "cloud-logging", relationships: { service_plan: { data: { guid: "plan-1" } } } },
        { guid: "inst-2", name: "cloud-logging", relationships: { service_plan: { data: { guid: "plan-2" } } } },
      ],
      included: {
        service_plans: [
          { guid: "plan-1", relationships: { service_offering: { data: { guid: "off-1" } } } },
          { guid: "plan-2", relationships: null }, // No offering relationship
        ],
        service_offerings: [{ guid: "off-1", name: "cloud-logging" }],
      },
    });
    const executor = fakeExecutor({ cfCurl: vi.fn(async () => response) });
    const instance = await discoverServiceInstance(TARGET, executor);
    expect(instance).toEqual({ name: "cloud-logging", guid: "inst-1" });
  });

  it("handles offerings not in the offering map", async () => {
    const response = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [
        { guid: "inst-1", name: "cloud-logging", relationships: { service_plan: { data: { guid: "plan-1" } } } },
        { guid: "inst-2", name: "other-service", relationships: { service_plan: { data: { guid: "plan-2" } } } },
      ],
      included: {
        service_plans: [
          { guid: "plan-1", relationships: { service_offering: { data: { guid: "off-1" } } } },
          { guid: "plan-2", relationships: { service_offering: { data: { guid: "off-missing" } } } }, // Offering not in included
        ],
        service_offerings: [{ guid: "off-1", name: "cloud-logging" }],
      },
    });
    const executor = fakeExecutor({ cfCurl: vi.fn(async () => response) });
    const instance = await discoverServiceInstance(TARGET, executor);
    expect(instance).toEqual({ name: "cloud-logging", guid: "inst-1" });
  });
});

describe("discoverDashboardsCredential", () => {
  it("reuses the ambient 'cf target' session when it already matches, skipping isolated login", async () => {
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "s" })),
      cfCurl: vi.fn(async (path: string) => {
        if (path.includes("service_instances")) {
          return INSTANCES_PAGE;
        }
        if (path.includes("/details")) {
          return jsonResponse({ credentials: { "dashboards-endpoint": "https://dash.example.com", "dashboards-username": "u", "dashboards-password": "p" } });
        }
        return jsonResponse({
          pagination: { total_pages: 1 },
          resources: [{ guid: "binding-1", type: "key", name: "key1", created_at: "2026-01-01T00:00:00Z" }],
          included: { apps: [] },
        });
      }),
    });

    const credential = await discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: false, verbose: false }, executor);

    expect(credential).toEqual({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", source: "service-key:key1", instance: "cloud-logging" });
    expect(executor.withCfSession).not.toHaveBeenCalled();
  });

  it("falls through to an isolated login when there is no matching ambient session and SAP credentials are given", async () => {
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => undefined),
      cfCurl: vi.fn(async (path: string) => {
        if (path.includes("service_instances")) {
          return INSTANCES_PAGE;
        }
        if (path.includes("/details")) {
          return jsonResponse({ credentials: { "dashboards-endpoint": "https://dash.example.com", "dashboards-username": "u", "dashboards-password": "p" } });
        }
        return jsonResponse({ pagination: { total_pages: 1 }, resources: [{ guid: "binding-1", type: "key", name: "key1", created_at: "2026-01-01T00:00:00Z" }], included: { apps: [] } });
      }),
    });

    const credential = await discoverDashboardsCredential(TARGET, { email: "e@x.com", password: "pw" }, { allowMintCredential: false, verbose: false }, executor);

    expect(credential.source).toBe("service-key:key1");
    expect(executor.withCfSession).toHaveBeenCalledTimes(1);
    expect(executor.cfApi).toHaveBeenCalledWith("e", expect.anything());
  });

  it("throws a clear, actionable error when neither an ambient session nor SAP credentials are available", async () => {
    const executor = fakeExecutor({ readCurrentCfTarget: vi.fn(async () => undefined) });
    await expect(discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: false, verbose: false }, executor)).rejects.toThrow(
      /SAP_EMAIL\/SAP_PASSWORD are not set/,
    );
  });

  it("prioritizes service keys over app bindings", async () => {
    const bindingsPage = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [
        { guid: "bind-1", type: "app", name: null, created_at: "2020-01-01T00:00:00Z", relationships: { app: { data: { guid: "app-1" } } } },
        { guid: "key-1", type: "key", name: "mykey", created_at: "2026-01-01T00:00:00Z" },
      ],
      included: { apps: [{ guid: "app-1", name: "legacy-app" }] },
    });
    const detailsCalls: string[] = [];
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "s" })),
      cfCurl: vi.fn(async (path: string) => {
        if (path.includes("service_instances")) {
          return INSTANCES_PAGE;
        }
        if (path.includes("/details")) {
          detailsCalls.push(path);
          return jsonResponse({ credentials: { "dashboards-endpoint": "e", "dashboards-username": "u", "dashboards-password": "p" } });
        }
        return bindingsPage;
      }),
    });

    const credential = await discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: false, verbose: false }, executor);

    expect(credential.source).toBe("service-key:mykey");
  });

  it("handles endpoint normalization with trailing slashes", async () => {
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e/", regionKey: "br10", orgName: "o", spaceName: "s" })),
      cfCurl: vi.fn(async (path: string) => {
        if (path.includes("service_instances")) {
          return INSTANCES_PAGE;
        }
        if (path.includes("/details")) {
          return jsonResponse({ credentials: { "dashboards-endpoint": "https://dash.example.com", "dashboards-username": "u", "dashboards-password": "p" } });
        }
        return jsonResponse({
          pagination: { total_pages: 1 },
          resources: [{ guid: "binding-1", type: "key", name: "key1", created_at: "2026-01-01T00:00:00Z" }],
          included: { apps: [] },
        });
      }),
    });

    const credential = await discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: false, verbose: false }, executor);

    expect(credential.source).toBe("service-key:key1");
    expect(executor.withCfSession).not.toHaveBeenCalled();
  });

  it("detects when target changes during discovery and throws", async () => {
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "s" })),
      cfCurl: vi.fn(async (path: string) => {
        if (path.includes("service_instances")) {
          return INSTANCES_PAGE;
        }
        if (path.includes("/details")) {
          return jsonResponse({ credentials: { "dashboards-endpoint": "https://dash.example.com", "dashboards-username": "u", "dashboards-password": "p" } });
        }
        return jsonResponse({
          pagination: { total_pages: 1 },
          resources: [{ guid: "binding-1", type: "key", name: "key1", created_at: "2026-01-01T00:00:00Z" }],
          included: { apps: [] },
        });
      }),
    });
    let callCount = 0;
    executor.readCurrentCfTarget = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return { apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "s" };
      }
      return { apiEndpoint: "different", regionKey: "br10", orgName: "o", spaceName: "s" };
    });

    await expect(discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: false, verbose: false }, executor)).rejects.toThrow(/session changed while discovery/);
  });

  it("rejects mismatched org in ambient session", async () => {
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "different-org", spaceName: "s" })),
    });

    await expect(discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: false, verbose: false }, executor)).rejects.toThrow(/SAP_EMAIL\/SAP_PASSWORD are not set/);
  });

  it("rejects mismatched space in ambient session", async () => {
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "different-space" })),
    });

    await expect(discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: false, verbose: false }, executor)).rejects.toThrow(/SAP_EMAIL\/SAP_PASSWORD are not set/);
  });

  it("rejects mismatched endpoint in ambient session", async () => {
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "different-api.com", regionKey: "br10", orgName: "o", spaceName: "s" })),
    });

    await expect(discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: false, verbose: false }, executor)).rejects.toThrow(/SAP_EMAIL\/SAP_PASSWORD are not set/);
  });

  it("handles empty binding list gracefully", async () => {
    const emptyBindings = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [],
      included: { apps: [] },
    });
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "s" })),
      cfCurl: vi.fn(async (path: string) => {
        if (path.includes("service_instances")) {
          return INSTANCES_PAGE;
        }
        return emptyBindings;
      }),
    });

    await expect(discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: false, verbose: false }, executor)).rejects.toThrow(/has no service keys or app bindings/);
  });

  it("filters bindings by service key names when specified", async () => {
    const bindingsPage = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [
        { guid: "key-1", type: "key", name: "include-me", created_at: "2026-01-01T00:00:00Z" },
        { guid: "key-2", type: "key", name: "exclude-me", created_at: "2026-01-02T00:00:00Z" },
      ],
      included: { apps: [] },
    });
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "s" })),
      cfCurl: vi.fn(async (path: string) => {
        if (path.includes("service_instances")) {
          return INSTANCES_PAGE;
        }
        if (path.includes("/details")) {
          return jsonResponse({ credentials: { "dashboards-endpoint": "https://dash.example.com", "dashboards-username": "u", "dashboards-password": "p" } });
        }
        return bindingsPage;
      }),
    });

    const credential = await discoverDashboardsCredential(TARGET, undefined, { serviceKeyNames: ["include-me"], allowMintCredential: false, verbose: false }, executor);

    expect(credential.source).toBe("service-key:include-me");
  });

  it("sorts service keys before app bindings", async () => {
    const bindingsPage = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [
        { guid: "app-1", type: "app", name: null, created_at: "2026-01-01T00:00:00Z", relationships: { app: { data: { guid: "app-guid-1" } } } },
        { guid: "key-1", type: "key", name: "mykey", created_at: "2025-01-01T00:00:00Z" },
      ],
      included: { apps: [{ guid: "app-guid-1", name: "app-name" }] },
    });
    const detailsAttempts: string[] = [];
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "s" })),
      cfCurl: vi.fn(async (path: string) => {
        if (path.includes("service_instances")) {
          return INSTANCES_PAGE;
        }
        if (path.includes("/details")) {
          detailsAttempts.push(path);
          return jsonResponse({ credentials: { "dashboards-endpoint": "https://dash.example.com", "dashboards-username": "u", "dashboards-password": "p" } });
        }
        return bindingsPage;
      }),
    });

    const credential = await discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: false, verbose: false }, executor);

    // Should fetch details for key first, not the app binding
    expect(detailsAttempts[0]).toContain("key-1");
    expect(credential.source).toBe("service-key:mykey");
  });

  it("handles binding without valid credentials", async () => {
    const bindingsPage = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [
        { guid: "key-1", type: "key", name: "old-key", created_at: "2020-01-01T00:00:00Z" },
        { guid: "key-2", type: "key", name: "new-key", created_at: "2026-01-01T00:00:00Z" },
      ],
      included: { apps: [] },
    });
    const detailsForBinding: Record<string, string> = {
      "key-1": jsonResponse({ credentials: { "dashboards-endpoint": "https://dash.example.com" } }),  // Missing username/password
      "key-2": jsonResponse({ credentials: { "dashboards-endpoint": "https://dash.example.com", "dashboards-username": "u", "dashboards-password": "p" } }),
    };
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "s" })),
      cfCurl: vi.fn(async (path: string) => {
        if (path.includes("service_instances")) {
          return INSTANCES_PAGE;
        }
        if (path.includes("/details")) {
          for (const [guid, details] of Object.entries(detailsForBinding)) {
            if (path.includes(guid)) {
              return details;
            }
          }
          return jsonResponse({ credentials: { "dashboards-endpoint": "https://dash.example.com", "dashboards-username": "u", "dashboards-password": "p" } });
        }
        return bindingsPage;
      }),
    });

    const credential = await discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: false, verbose: false }, executor);

    expect(credential.source).toBe("service-key:new-key");
  });

  it("handles auth failures in credential discovery", async () => {
    const bindingsPage = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [{ guid: "key-1", type: "key", name: "key1", created_at: "2026-01-01T00:00:00Z" }],
      included: { apps: [] },
    });
    const authError = new Error("401 Unauthorized");
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "s" })),
      cfCurl: vi.fn(async (path: string) => {
        if (path.includes("service_instances")) {
          return INSTANCES_PAGE;
        }
        if (path.includes("/details")) {
          throw authError;
        }
        return bindingsPage;
      }),
      isCfAuthFailure: vi.fn((error) => error === authError),
    });

    await expect(discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: false, verbose: false }, executor)).rejects.toThrow("401 Unauthorized");
  });

  it("uses explicit service instance when provided", async () => {
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "s" })),
      cfServiceGuid: vi.fn(async () => "explicit-inst-guid"),
      cfCurl: vi.fn(async (path: string) => {
        if (path.includes("/details")) {
          return jsonResponse({ credentials: { "dashboards-endpoint": "https://dash.example.com", "dashboards-username": "u", "dashboards-password": "p" } });
        }
        return jsonResponse({
          pagination: { total_pages: 1 },
          resources: [{ guid: "binding-1", type: "key", name: "key1", created_at: "2026-01-01T00:00:00Z" }],
          included: { apps: [] },
        });
      }),
    });

    const credential = await discoverDashboardsCredential(TARGET, undefined, { serviceInstance: "my-instance", allowMintCredential: false, verbose: false }, executor);

    expect(credential.instance).toBe("my-instance");
    expect(executor.cfServiceGuid).toHaveBeenCalledWith("my-instance", expect.anything());
  });

  it("rejects all filtered bindings and throws", async () => {
    const bindingsPage = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [
        { guid: "key-1", type: "key", name: "exclude-me", created_at: "2026-01-01T00:00:00Z" },
        { guid: "key-2", type: "key", name: "also-exclude", created_at: "2026-01-02T00:00:00Z" },
      ],
      included: { apps: [] },
    });
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "s" })),
      cfCurl: vi.fn(async (path: string) => {
        if (path.includes("service_instances")) {
          return INSTANCES_PAGE;
        }
        return bindingsPage;
      }),
    });

    await expect(discoverDashboardsCredential(TARGET, undefined, { serviceKeyNames: ["nonexistent"], allowMintCredential: false, verbose: false }, executor)).rejects.toThrow(
      /all.*binding.*were excluded by --service-key/,
    );
  });

  it("throws clear error when allowMintCredential is set but not implemented", async () => {
    const bindingsPage = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [], // No bindings available
      included: { apps: [] },
    });
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "s" })),
      cfCurl: vi.fn(async (path: string) => {
        if (path.includes("service_instances")) {
          return INSTANCES_PAGE;
        }
        return bindingsPage;
      }),
    });

    await expect(discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: true, verbose: false }, executor)).rejects.toThrow(
      /Minting.*not implemented in the shared core module/,
    );
  });

  it("handles app binding errors gracefully", async () => {
    const bindingsPage = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [{ guid: "app-binding-1", type: "app", name: null, created_at: "2026-01-01T00:00:00Z", relationships: { app: { data: { guid: "app-1" } } } }],
      included: { apps: [{ guid: "app-1", name: "my-app" }] },
    });
    const error = new Error("Request failed");
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "s" })),
      cfCurl: vi.fn(async (path: string) => {
        if (path.includes("service_instances")) {
          return INSTANCES_PAGE;
        }
        if (path.includes("/details")) {
          throw error;
        }
        return bindingsPage;
      }),
      isCfAuthFailure: vi.fn(() => false),
    });

    await expect(discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: false, verbose: false }, executor)).rejects.toThrow(/Could not resolve Cloud Logging dashboards credentials/);
  });

  it("handles binding with malformed relationships", async () => {
    const bindingsPage = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [
        { guid: "key-1", type: "key", name: "key1", created_at: "2026-01-01T00:00:00Z", relationships: "not-an-object" },
      ],
      included: { apps: [] },
    });
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "s" })),
      cfCurl: vi.fn(async (path: string) => {
        if (path.includes("service_instances")) {
          return INSTANCES_PAGE;
        }
        if (path.includes("/details")) {
          return jsonResponse({ credentials: { "dashboards-endpoint": "https://dash.example.com", "dashboards-username": "u", "dashboards-password": "p" } });
        }
        return bindingsPage;
      }),
    });

    const credential = await discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: false, verbose: false }, executor);

    expect(credential.source).toBe("service-key:key1");
  });

  it("handles binding with missing included.apps", async () => {
    const bindingsPage = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [
        { guid: "app-1", type: "app", name: null, created_at: "2026-01-01T00:00:00Z", relationships: { app: { data: { guid: "app-guid-1" } } } },
      ],
      included: {}, // No apps array
    });
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "s" })),
      cfCurl: vi.fn(async (path: string) => {
        if (path.includes("service_instances")) {
          return INSTANCES_PAGE;
        }
        if (path.includes("/details")) {
          return jsonResponse({ credentials: { "dashboards-endpoint": "https://dash.example.com", "dashboards-username": "u", "dashboards-password": "p" } });
        }
        return bindingsPage;
      }),
    });

    const credential = await discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: false, verbose: false }, executor);

    // Should use binding guid as label fallback when app name not found
    expect(credential.source).toBe("binding:app-1");
  });

  it("handles binding response without credentials object", async () => {
    const bindingsPage = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [{ guid: "key-1", type: "key", name: "key1", created_at: "2026-01-01T00:00:00Z" }],
      included: { apps: [] },
    });
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "s" })),
      cfCurl: vi.fn(async (path: string) => {
        if (path.includes("service_instances")) {
          return INSTANCES_PAGE;
        }
        if (path.includes("/details")) {
          return jsonResponse({}); // No credentials
        }
        return bindingsPage;
      }),
    });

    await expect(discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: false, verbose: false }, executor)).rejects.toThrow(/Could not resolve Cloud Logging dashboards credentials/);
  });

  it("logs verbose messages during discovery", async () => {
    const bindingsPage = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [{ guid: "key-1", type: "key", name: "key1", created_at: "2026-01-01T00:00:00Z" }],
      included: { apps: [] },
    });
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "s" })),
      cfCurl: vi.fn(async (path: string) => {
        if (path.includes("service_instances")) {
          return INSTANCES_PAGE;
        }
        if (path.includes("/details")) {
          return jsonResponse({ credentials: { "dashboards-endpoint": "https://dash.example.com", "dashboards-username": "u", "dashboards-password": "p" } });
        }
        return bindingsPage;
      }),
    });

    // Just verify it doesn't crash with verbose=true
    const credential = await discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: false, verbose: true }, executor);

    expect(credential.source).toBe("service-key:key1");
  });

  it("handles non-Error exceptions from ambient session", async () => {
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "s" })),
      cfCurl: vi.fn().mockRejectedValueOnce("non-error rejection"),
      isCfAuthFailure: vi.fn(() => true),
    });

    await expect(discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: false, verbose: false }, executor)).rejects.toThrow();
  });

  it("handles non-Error exceptions when binding credential fetch fails", async () => {
    const bindingsPage = jsonResponse({
      pagination: { total_pages: 1 },
      resources: [
        { guid: "key-1", type: "key", name: "fail-key", created_at: "2026-01-02T00:00:00Z" },
        { guid: "key-2", type: "key", name: "success-key", created_at: "2026-01-01T00:00:00Z" },
      ],
      included: { apps: [] },
    });
    let credentialAttempts = 0;
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "s" })),
      cfCurl: vi.fn(async (path: string) => {
        if (path.includes("service_instances")) {
          return INSTANCES_PAGE;
        }
        if (path.includes("service_credential_bindings")) {
          if (path.includes("details")) {
            if (path.includes("key-1")) {
              credentialAttempts += 1;
              // eslint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error
              throw "non-error rejection from first binding";
            }
            // key-2 details
            return jsonResponse({ credentials: { "dashboards-endpoint": "https://dash.example.com", "dashboards-username": "user2", "dashboards-password": "pass2" } });
          }
          return bindingsPage;
        }
        return bindingsPage;
      }),
      isCfAuthFailure: vi.fn(() => false),
    });

    const result = await discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: false, verbose: false }, executor);
    expect(result.username).toBe("user2");
    expect(result.password).toBe("pass2");
    expect(credentialAttempts).toBe(1);
  });

  it("paginates through multiple pages of credential bindings", async () => {
    const page1 = jsonResponse({
      pagination: { total_pages: 2 },
      resources: [
        { guid: "key-page1", type: "key", name: "key-from-page-1", created_at: "2026-01-01T00:00:00Z" },
      ],
      included: { apps: [] },
    });
    const page2 = jsonResponse({
      pagination: { total_pages: 2 },
      resources: [
        { guid: "key-page2", type: "key", name: "key-from-page-2", created_at: "2026-01-02T00:00:00Z" },
      ],
      included: { apps: [] },
    });
    let pageRequested = 0;
    const executor = fakeExecutor({
      readCurrentCfTarget: vi.fn(async () => ({ apiEndpoint: "e", regionKey: "br10", orgName: "o", spaceName: "s" })),
      cfCurl: vi.fn(async (path: string) => {
        if (path.includes("service_instances")) {
          return INSTANCES_PAGE;
        }
        if (path.includes("service_credential_bindings")) {
          if (path.includes("page=2")) {
            pageRequested = 2;
          } else if (path.includes("page=1")) {
            pageRequested = 1;
          }
          if (path.includes("details")) {
            return jsonResponse({ credentials: { "dashboards-endpoint": "https://dash.example.com", "dashboards-username": "user", "dashboards-password": "pass" } });
          }
          return pageRequested === 2 ? page2 : page1;
        }
        return page1;
      }),
      isCfAuthFailure: vi.fn(() => false),
    });

    const result = await discoverDashboardsCredential(TARGET, undefined, { allowMintCredential: false, verbose: false }, executor);

    // Verify the function successfully resolved a credential
    expect(result).toBeDefined();
    expect(result.username).toBe("user");

    // Verify pagination occurred: cfCurl should have been called at least 3 times
    // (service_instances, page 1 bindings list, page 2 bindings list, then /details)
    const mockCfCurl = executor.cfCurl as ReturnType<typeof vi.fn>;
    const calls = mockCfCurl.mock.calls;
    const bindingCalls = calls.filter((call: unknown[]) => {
      const path = typeof call[0] === "string" ? call[0] : "";
      return path.includes("service_credential_bindings") && !path.includes("details");
    });
    expect(bindingCalls.length).toBeGreaterThanOrEqual(2);

    // Verify page=2 was actually requested
    const hasPage2Request = calls.some((call: unknown[]) => {
      const path = typeof call[0] === "string" ? call[0] : "";
      return path.includes("page=2");
    });
    expect(hasPage2Request).toBe(true);
  });
});
