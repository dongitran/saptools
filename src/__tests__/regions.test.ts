import { describe, it, expect } from "vitest";
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
});

describe("getAllRegions", () => {
  it("returns all supported regions", () => {
    const regions = getAllRegions();

    expect(regions).toHaveLength(2);
    expect(regions.map((r) => r.key)).toContain("ap11");
    expect(regions.map((r) => r.key)).toContain("br10");
  });

  it("every region has a non-empty label and endpoint", () => {
    for (const region of getAllRegions()) {
      expect(region.label.length).toBeGreaterThan(0);
      expect(region.apiEndpoint).toMatch(/^https:\/\//);
    }
  });
});
