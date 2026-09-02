import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import * as cf from "../../src/cf.js";
import { discoverServiceInstance, listCloudLoggingInstances } from "../../src/service-discovery.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const SPACE_GUID = "1af3e621-59f5-439c-9838-4508ae8be431";
const CTX = { cfHome: "/tmp/fake" };

interface FakeInstance {
  readonly name: string;
  readonly guid: string;
  readonly offering: string;
  readonly page?: number;
}

/**
 * The real v3 shape, verified live: an instance only references its plan, the
 * plan only references its offering, and both sidecars arrive under
 * `included` because the request asked for them with `fields[...]`.
 */
function listingFor(instances: readonly FakeInstance[], page: number, totalPages: number): string {
  const onPage = instances.filter((instance) => (instance.page ?? 1) === page);
  const offerings = [...new Set(onPage.map((instance) => instance.offering))];
  return JSON.stringify({
    pagination: { total_results: instances.length, total_pages: totalPages },
    resources: onPage.map((instance) => ({
      guid: instance.guid,
      name: instance.name,
      type: "managed",
      relationships: { service_plan: { data: { guid: `plan-${instance.offering}` } } },
    })),
    included: {
      service_plans: offerings.map((offering) => ({
        guid: `plan-${offering}`,
        name: "large",
        relationships: { service_offering: { data: { guid: `offering-${offering}` } } },
      })),
      service_offerings: offerings.map((offering) => ({ guid: `offering-${offering}`, name: offering })),
    },
  });
}

function stubCf(instances: readonly FakeInstance[], totalPages = 1): MockInstance<typeof cf.cfCurl> {
  vi.spyOn(cf, "cfSpaceGuid").mockResolvedValue(SPACE_GUID);
  return vi.spyOn(cf, "cfCurl").mockImplementation(async (path: string) => {
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? "1");
    return listingFor(instances, page, totalPages);
  });
}

const LOGGING = { name: "my-logging", guid: "6e0619da-64f4-43e0-b248-a434750ee17f", offering: "cloud-logging" };
const HANA = { name: "my-hana", guid: "0a7cf0f4-5cc9-4d7a-8b8e-6f1e3a2b9c01", offering: "hana" };

describe("listCloudLoggingInstances", () => {
  it("scopes the v3 listing to the space's GUID and asks for the plan/offering sidecars it filters on", async () => {
    const curl = stubCf([LOGGING, HANA]);

    await listCloudLoggingInstances("app", CTX);

    expect(cf.cfSpaceGuid).toHaveBeenCalledWith("app", CTX);
    const path = String(curl.mock.calls[0]?.[0]);
    expect(path).toContain(`/v3/service_instances?space_guids=${SPACE_GUID}`);
    expect(path).toContain("type=managed");
    // The brackets travel percent-encoded; the decoded form is what the Cloud Controller sees.
    expect(path).not.toContain("[");
    expect(decodeURIComponent(path)).toContain("fields[service_plan]=guid,name,relationships.service_offering");
    expect(decodeURIComponent(path)).toContain("fields[service_plan.service_offering]=guid,name");
  });

  it("keeps only instances whose offering is cloud-logging, with the GUID the bindings listing needs", async () => {
    stubCf([HANA, LOGGING]);

    await expect(listCloudLoggingInstances("app", CTX)).resolves.toEqual([{ name: LOGGING.name, guid: LOGGING.guid }]);
  });

  it("walks every page of the listing", async () => {
    stubCf([HANA, { ...LOGGING, page: 2 }], 2);

    const instances = await listCloudLoggingInstances("app", CTX);

    expect(instances.map((instance) => instance.name)).toEqual([LOGGING.name]);
    expect(cf.cfCurl).toHaveBeenCalledTimes(2);
  });

  it("returns nothing when the space has no managed instances at all", async () => {
    stubCf([]);

    await expect(listCloudLoggingInstances("app", CTX)).resolves.toEqual([]);
  });

  it("fails clearly when cf curl returns something other than JSON", async () => {
    vi.spyOn(cf, "cfSpaceGuid").mockResolvedValue(SPACE_GUID);
    vi.spyOn(cf, "cfCurl").mockResolvedValue("FAILED\nNot logged in.");

    await expect(listCloudLoggingInstances("app", CTX)).rejects.toThrow(/did not return a JSON document/);
  });
});

describe("discoverServiceInstance", () => {
  it("returns the single matching instance", async () => {
    stubCf([HANA, LOGGING]);

    await expect(discoverServiceInstance("app", CTX)).resolves.toEqual({ name: LOGGING.name, guid: LOGGING.guid });
  });

  it("fails closed when zero instances match", async () => {
    stubCf([HANA]);

    await expect(discoverServiceInstance("app", CTX)).rejects.toThrow(/No "cloud-logging" service instance found/);
  });

  it("fails closed when multiple instances match, naming all of them", async () => {
    stubCf([
      { ...LOGGING, name: "cl-1" },
      { ...LOGGING, name: "cl-2", guid: "9b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9" },
    ]);

    await expect(discoverServiceInstance("app", CTX)).rejects.toThrow(/cl-1, cl-2/);
  });
});
