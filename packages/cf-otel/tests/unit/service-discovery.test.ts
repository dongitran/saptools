import { afterEach, describe, expect, it, vi } from "vitest";

import * as cf from "../../src/cf.js";
import { discoverServiceInstance, findBoundApps, listCloudLoggingInstances } from "../../src/service-discovery.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// `cf services` pads every column to a fixed width so the header word and the
// data below it start at the same character offset — hand-typing that
// alignment is error-prone, so build rows from fixed column widths instead.
function servicesRow(name: string, offering: string, plan: string, boundApps: string, lastOp: string): string {
  return name.padEnd(17) + offering.padEnd(16) + plan.padEnd(11) + boundApps.padEnd(20) + lastOp;
}

const SERVICES_STDOUT = [
  servicesRow("name", "offering", "plan", "bound apps", "last operation"),
  servicesRow("cloud-logging", "cloud-logging", "standard", "app1, app2", "create succeeded"),
  servicesRow("other-service", "xsuaa", "broker", "app1", "create succeeded"),
].join("\n");

describe("listCloudLoggingInstances", () => {
  it("filters to only the cloud-logging offering", async () => {
    vi.spyOn(cf, "cfServices").mockResolvedValue(SERVICES_STDOUT);
    const rows = await listCloudLoggingInstances({ cfHome: "/tmp/fake" });
    expect(rows).toEqual([{ name: "cloud-logging", offering: "cloud-logging", boundApps: ["app1", "app2"] }]);
  });
});

describe("discoverServiceInstance", () => {
  it("returns the single matching instance", async () => {
    vi.spyOn(cf, "cfServices").mockResolvedValue(SERVICES_STDOUT);
    expect(await discoverServiceInstance({ cfHome: "/tmp/fake" })).toBe("cloud-logging");
  });

  it("fails closed when zero instances match", async () => {
    vi.spyOn(cf, "cfServices").mockResolvedValue(servicesRow("name", "offering", "plan", "bound apps", "last operation"));
    await expect(discoverServiceInstance({ cfHome: "/tmp/fake" })).rejects.toThrow(/No "cloud-logging" service instance found/);
  });

  it("fails closed when multiple instances match, naming all of them", async () => {
    const stdout = [
      servicesRow("name", "offering", "plan", "bound apps", "last operation"),
      servicesRow("cl-1", "cloud-logging", "std", "", "create succeeded"),
      servicesRow("cl-2", "cloud-logging", "std", "", "create succeeded"),
    ].join("\n");
    vi.spyOn(cf, "cfServices").mockResolvedValue(stdout);
    await expect(discoverServiceInstance({ cfHome: "/tmp/fake" })).rejects.toThrow(/cl-1, cl-2/);
  });
});

describe("findBoundApps", () => {
  it("returns the bound apps for a named instance", async () => {
    vi.spyOn(cf, "cfServices").mockResolvedValue(SERVICES_STDOUT);
    expect(await findBoundApps("cloud-logging", { cfHome: "/tmp/fake" })).toEqual(["app1", "app2"]);
  });

  it("returns an empty list for an instance that is not found", async () => {
    vi.spyOn(cf, "cfServices").mockResolvedValue(SERVICES_STDOUT);
    expect(await findBoundApps("does-not-exist", { cfHome: "/tmp/fake" })).toEqual([]);
  });
});
