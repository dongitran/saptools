import { describe, it, expect } from "vitest";
import { REGION_KEYS } from "../types.js";
import { getRegion, getAllRegions } from "../regions.js";

describe("getRegion", () => {
  it("returns ap11 region with correct API endpoint", () => {
    const region = getRegion("ap11");

    expect(region.key).toBe("ap11");
    expect(region.apiEndpoint).toBe("https://api.cf.ap11.hana.ondemand.com");
    expect(region.label).toContain("Singapore");
  });

  it("returns br10 region with correct API endpoint", () => {
    const region = getRegion("br10");

    expect(region.key).toBe("br10");
    expect(region.apiEndpoint).toBe("https://api.cf.br10.hana.ondemand.com");
    expect(region.label).toContain("Brazil");
  });

  it("returns ca20 region with correct API endpoint", () => {
    const region = getRegion("ca20");

    expect(region.key).toBe("ca20");
    expect(region.apiEndpoint).toBe("https://api.cf.ca20.hana.ondemand.com");
    expect(region.label).toContain("Canada");
  });
});

describe("getAllRegions", () => {
  it("returns all supported regions", () => {
    const regions = getAllRegions();
    const keys = regions.map((r) => r.key);

    expect(regions).toHaveLength(REGION_KEYS.length);
    for (const key of REGION_KEYS) {
      expect(keys).toContain(key);
    }
  });

  it("every region has a non-empty label and endpoint", () => {
    for (const region of getAllRegions()) {
      expect(region.label.length).toBeGreaterThan(0);
      expect(region.apiEndpoint).toMatch(/^https:\/\//);
    }
  });
});
