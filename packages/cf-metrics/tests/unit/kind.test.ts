import { describe, expect, it } from "vitest";

import { buildKindSubAggs, isCumulativeTemporality, parseMetricKind, shapeHistoryBucket } from "../../src/kind.js";

describe("parseMetricKind", () => {
  it("accepts GAUGE, SUM, and HISTOGRAM", () => {
    expect(parseMetricKind("GAUGE")).toBe("GAUGE");
    expect(parseMetricKind("SUM")).toBe("SUM");
    expect(parseMetricKind("HISTOGRAM")).toBe("HISTOGRAM");
  });

  it("throws on an unknown kind", () => {
    expect(() => parseMetricKind("COUNTER")).toThrow(/Unknown metric kind/);
  });
});

describe("buildKindSubAggs", () => {
  it("requests avg/min/max for GAUGE", () => {
    expect(buildKindSubAggs("GAUGE")).toEqual({
      avg_value: { avg: { field: "value" } },
      min_value: { min: { field: "value" } },
      max_value: { max: { field: "value" } },
    });
  });

  it("requests a single sum for SUM", () => {
    expect(buildKindSubAggs("SUM")).toEqual({ sum_value: { sum: { field: "value" } } });
  });

  it("requests count and sum sums for HISTOGRAM", () => {
    expect(buildKindSubAggs("HISTOGRAM")).toEqual({
      sum_count: { sum: { field: "count" } },
      sum_sum: { sum: { field: "sum" } },
    });
  });
});

describe("shapeHistoryBucket", () => {
  it("shapes a GAUGE bucket into TIME/AVG/MIN/MAX/DOC_COUNT, from real container.cpu.usage-shaped data", () => {
    const bucket = {
      key_as_string: "2026-08-31T10:00:00.000Z",
      doc_count: 84,
      avg_value: { value: 0.11689719485153069 },
      min_value: { value: 0.0187 },
      max_value: { value: 0.157 },
    };
    expect(shapeHistoryBucket("GAUGE", bucket)).toEqual({
      TIME: "2026-08-31T10:00:00.000Z",
      AVG: 0.11689719485153069,
      MIN: 0.0187,
      MAX: 0.157,
      DOC_COUNT: 84,
    });
  });

  it("falls back to null for GAUGE sub-aggs that never matched a document", () => {
    expect(shapeHistoryBucket("GAUGE", { key_as_string: "t", doc_count: 0 })).toEqual({
      TIME: "t",
      AVG: null,
      MIN: null,
      MAX: null,
      DOC_COUNT: 0,
    });
  });

  it("shapes a SUM bucket into TIME/SUM/DOC_COUNT, from real queue.incoming_messages-shaped data", () => {
    const bucket = { key_as_string: "2026-08-31T11:00:00.000Z", doc_count: 45, sum_value: { value: 3 } };
    expect(shapeHistoryBucket("SUM", bucket)).toEqual({ TIME: "2026-08-31T11:00:00.000Z", SUM: 3, DOC_COUNT: 45 });
  });

  it("defaults SUM to 0 when the sub-agg produced no value", () => {
    expect(shapeHistoryBucket("SUM", { key_as_string: "t", doc_count: 0 })).toEqual({ TIME: "t", SUM: 0, DOC_COUNT: 0 });
  });

  it("derives AVG as sumOfSum / sumOfCount for a HISTOGRAM bucket, from real http.server.duration-shaped data", () => {
    const bucket = { key_as_string: "t", doc_count: 15, sum_count: { value: 30 }, sum_sum: { value: 28.025429 } };
    const row = shapeHistoryBucket("HISTOGRAM", bucket);
    expect(row["COUNT"]).toBe(30);
    expect(row["SUM"]).toBeCloseTo(28.025429);
    expect(row["AVG"]).toBeCloseTo(28.025429 / 30);
  });

  it("reports a null AVG for a HISTOGRAM bucket with zero matching requests, instead of dividing by zero", () => {
    const bucket = { key_as_string: "t", doc_count: 0, sum_count: { value: 0 }, sum_sum: { value: 0 } };
    expect(shapeHistoryBucket("HISTOGRAM", bucket)["AVG"]).toBeNull();
  });
});

describe("isCumulativeTemporality", () => {
  it("returns true for a document reporting AGGREGATION_TEMPORALITY_CUMULATIVE", () => {
    expect(isCumulativeTemporality({ aggregationTemporality: "AGGREGATION_TEMPORALITY_CUMULATIVE" })).toBe(true);
  });

  it("returns false for a document reporting AGGREGATION_TEMPORALITY_DELTA", () => {
    expect(isCumulativeTemporality({ aggregationTemporality: "AGGREGATION_TEMPORALITY_DELTA" })).toBe(false);
  });

  it("returns false when no sample document is available", () => {
    expect(isCumulativeTemporality(undefined)).toBe(false);
  });
});
