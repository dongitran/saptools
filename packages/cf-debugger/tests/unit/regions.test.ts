import { describe, expect, it } from "vitest";

import { listKnownRegionKeys, resolveApiEndpoint } from "../../src/regions.js";

describe("resolveApiEndpoint", () => {
  it("maps a known region key to its SAP CF API endpoint", () => {
    expect(resolveApiEndpoint("eu10")).toBe("https://api.cf.eu10.hana.ondemand.com");
  });

  it("honours an override when provided", () => {
    expect(resolveApiEndpoint("eu10", "https://custom.example.com")).toBe(
      "https://custom.example.com",
    );
  });

  it("throws for unknown keys when no override is given", () => {
    expect(() => resolveApiEndpoint("xx99")).toThrow(/Unknown region key/);
  });

  it("lists at least a handful of known regions", () => {
    const keys = listKnownRegionKeys();
    expect(keys.length).toBeGreaterThan(10);
    expect(keys).toContain("eu10");
    expect(keys).toContain("ap10");
  });
});
