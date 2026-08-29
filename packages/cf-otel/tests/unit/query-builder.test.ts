import { describe, expect, it } from "vitest";

import { buildSpanBoolQuery, resolveTimeBound } from "../../src/query-builder.js";

describe("resolveTimeBound", () => {
  const now = new Date("2026-08-29T12:00:00.000Z");

  it("resolves a relative hours duration against the given now", () => {
    expect(resolveTimeBound("24h", now)).toBe("2026-08-28T12:00:00.000Z");
  });

  it("resolves a relative minutes duration", () => {
    expect(resolveTimeBound("30m", now)).toBe("2026-08-29T11:30:00.000Z");
  });

  it("resolves a relative days duration", () => {
    expect(resolveTimeBound("2d", now)).toBe("2026-08-27T12:00:00.000Z");
  });

  it("passes an absolute ISO-8601 timestamp through unchanged", () => {
    expect(resolveTimeBound("2026-08-28T03:00:00Z", now)).toBe("2026-08-28T03:00:00Z");
  });
});

describe("buildSpanBoolQuery", () => {
  it("returns match_all when no filters are given", () => {
    expect(buildSpanBoolQuery({})).toEqual({ match_all: {} });
  });

  it("builds a term filter for service and a wildcard filter for name", () => {
    const query = buildSpanBoolQuery({ service: "service-a", namePattern: "*SyncBatchAction*" });
    expect(query).toEqual({
      bool: {
        filter: [{ term: { serviceName: "service-a" } }, { wildcard: { name: { value: "*SyncBatchAction*" } } }],
      },
    });
  });

  it("builds a status.code term filter for errorsOnly", () => {
    const query = buildSpanBoolQuery({ errorsOnly: true }) as { bool: { filter: unknown[] } };
    expect(query.bool.filter).toContainEqual({ term: { "status.code": 2 } });
  });

  it("builds a traceIds terms filter", () => {
    const query = buildSpanBoolQuery({ traceIds: ["a", "b"] }) as { bool: { filter: unknown[] } };
    expect(query.bool.filter).toContainEqual({ terms: { traceId: ["a", "b"] } });
  });

  it("builds a numeric range clause for a >= attr filter", () => {
    const query = buildSpanBoolQuery({ attrs: [{ key: "http@status_code", operator: ">=", value: "400" }] }) as {
      bool: { filter: unknown[] };
    };
    expect(query.bool.filter).toContainEqual({ range: { "http@status_code": { gte: 400 } } });
  });

  it("builds a numeric range clause for a <= attr filter", () => {
    const query = buildSpanBoolQuery({ attrs: [{ key: "http@status_code", operator: "<=", value: "299" }] }) as {
      bool: { filter: unknown[] };
    };
    expect(query.bool.filter).toContainEqual({ range: { "http@status_code": { lte: 299 } } });
  });

  it("builds a numeric range clause for a > attr filter", () => {
    const query = buildSpanBoolQuery({ attrs: [{ key: "http@status_code", operator: ">", value: "400" }] }) as {
      bool: { filter: unknown[] };
    };
    expect(query.bool.filter).toContainEqual({ range: { "http@status_code": { gt: 400 } } });
  });

  it("builds a numeric range clause for a < attr filter", () => {
    const query = buildSpanBoolQuery({ attrs: [{ key: "http@status_code", operator: "<", value: "500" }] }) as {
      bool: { filter: unknown[] };
    };
    expect(query.bool.filter).toContainEqual({ range: { "http@status_code": { lt: 500 } } });
  });

  it("builds a term clause for an = attr filter", () => {
    const query = buildSpanBoolQuery({ attrs: [{ key: "http@method", operator: "=", value: "POST" }] }) as {
      bool: { filter: unknown[] };
    };
    expect(query.bool.filter).toContainEqual({ term: { "http@method": "POST" } });
  });

  it("builds a wildcard contains clause for a ~ attr filter", () => {
    const query = buildSpanBoolQuery({ attrs: [{ key: "http@target", operator: "~", value: "Batch" }] }) as {
      bool: { filter: unknown[] };
    };
    expect(query.bool.filter).toContainEqual({ wildcard: { "http@target": { value: "*Batch*" } } });
  });

  it("throws when a numeric operator is given a non-numeric value", () => {
    expect(() => buildSpanBoolQuery({ attrs: [{ key: "http@status_code", operator: ">=", value: "nope" }] })).toThrow(
      /not numeric/,
    );
  });
});
