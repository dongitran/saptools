import { formatSearchResults, searchDefinitions } from "../../src/search.js";
import type { HanaLensCsn } from "../../src/types.js";
import { expect } from "../helpers/expect.js";
import { describe, it } from "../helpers/test.js";

const ast: HanaLensCsn = { definitions: {
  "srv.BusinessRequest": { "@hanaLens.packageName": "@demo/sales" },
  "srv.Customer": { "@hanaLens.packageName": "@demo/master" },
  "srv.Order": { "@hanaLens.packageName": "@demo/sales" },
  ...Object.fromEntries(Array.from({ length: 20 }, (_value, index) => [`srv.Generated${index.toString().padStart(2, "0")}`, { "@hanaLens.packageName": "@demo/generated" }])),
} };

describe("searchDefinitions", () => {
  it("returns dense case-insensitive fuzzy matches", () => {
    const results = searchDefinitions(ast, "businesreq", false);
    expect(results[0]?.name).toBe("srv.BusinessRequest");
    expect(formatSearchResults(results.slice(0, 1))).toBe("srv.BusinessRequest|@demo/sales");
  });

  it("uses regex without fuzzy ordering", () => {
    expect(searchDefinitions(ast, "Customer$", true)).toEqual([{ name: "srv.Customer", packageName: "@demo/master", score: 0 }]);
  });

  it("limits output to the top ten matches", () => {
    expect(searchDefinitions(ast, "srv", false)).toHaveLength(10);
  });

  it("surfaces invalid regular expressions and rejects empty keywords", () => {
    expect(() => searchDefinitions(ast, "[", true)).toThrow();
    expect(() => searchDefinitions(ast, "   ", false)).toThrow("Search keyword must not be empty");
  });
});