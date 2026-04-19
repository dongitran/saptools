import { describe, expect, it } from "vitest";

import { assertRegionKey } from "../../src/cf.js";

describe("assertRegionKey", () => {
  it("accepts a known region key", () => {
    expect(() => {
      assertRegionKey("eu10");
    }).not.toThrow();
  });

  it("throws for an unknown region key", () => {
    expect(() => {
      assertRegionKey("zz99");
    }).toThrow(/Unknown region key/);
  });
});
