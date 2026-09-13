import { describe, expect, it } from "vitest";

import { extractBuckets } from "../../src/aggregations.js";

describe("extractBuckets", () => {
  it("extracts key/doc_count pairs from a real terms-aggregation shape", () => {
    const buckets = extractBuckets({ by_app: { buckets: [{ key: "app-a", doc_count: 10 }, { key: "app-b", doc_count: 3 }] } }, "by_app");
    expect(buckets).toEqual([{ key: "app-a", docCount: 10 }, { key: "app-b", docCount: 3 }]);
  });

  it("returns an empty array when the named aggregation is absent", () => {
    expect(extractBuckets({}, "by_app")).toEqual([]);
    expect(extractBuckets(undefined, "by_app")).toEqual([]);
  });

  it("skips a malformed bucket rather than throwing", () => {
    expect(extractBuckets({ by_app: { buckets: [{ key: 42, doc_count: "not a number" }] } }, "by_app")).toEqual([]);
  });
});
