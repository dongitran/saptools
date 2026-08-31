import { describe, expect, it } from "vitest";

import { assertValidTimeBoundShape, buildMetricBoolQuery, resolveTimeBound } from "../../src/query-builder.js";

describe("resolveTimeBound", () => {
  const now = new Date("2026-08-31T12:00:00.000Z");

  it("resolves a relative hours duration against the given now", () => {
    expect(resolveTimeBound("2h", now)).toBe("2026-08-31T10:00:00.000Z");
  });

  it("resolves a relative minutes duration", () => {
    expect(resolveTimeBound("30m", now)).toBe("2026-08-31T11:30:00.000Z");
  });

  it("resolves a relative days duration", () => {
    expect(resolveTimeBound("2d", now)).toBe("2026-08-29T12:00:00.000Z");
  });

  it("passes an absolute ISO-8601 timestamp through unchanged", () => {
    expect(resolveTimeBound("2026-08-30T03:00:00Z", now)).toBe("2026-08-30T03:00:00Z");
  });
});

describe("assertValidTimeBoundShape", () => {
  it("accepts a relative duration", () => {
    expect(() => {
      assertValidTimeBoundShape("--since", "24h");
    }).not.toThrow();
  });

  it("accepts an absolute ISO-8601 timestamp with a time component", () => {
    expect(() => {
      assertValidTimeBoundShape("--since", "2026-08-30T03:00:00Z");
    }).not.toThrow();
  });

  it("accepts an absolute ISO-8601 timestamp with sub-second precision, as real metric `time` fields carry", () => {
    expect(() => {
      assertValidTimeBoundShape("--until", "2026-08-30T03:00:00.566267000Z");
    }).not.toThrow();
  });

  it("accepts a date-only ISO-8601 value", () => {
    expect(() => {
      assertValidTimeBoundShape("--since", "2026-08-30");
    }).not.toThrow();
  });

  it("rejects a value that is neither a relative duration nor an ISO-8601 timestamp, naming the offending flag", () => {
    expect(() => {
      assertValidTimeBoundShape("--since", "yesterday");
    }).toThrow(/Invalid --since value "yesterday"/);
  });

  it("rejects an ambiguous non-ISO date format rather than silently guessing its meaning", () => {
    // JS's own `Date.parse` would accept this (as a local-time, not UTC, instant) — reject it
    // instead of guessing, since it doesn't match the documented ISO-8601 contract.
    expect(() => {
      assertValidTimeBoundShape("--until", "8/31/2026");
    }).toThrow(/Invalid --until value "8\/31\/2026"/);
  });

  it("rejects an empty string", () => {
    expect(() => {
      assertValidTimeBoundShape("--since", "");
    }).toThrow(/Invalid --since value/);
  });
});

describe("buildMetricBoolQuery", () => {
  it("returns match_all when no filters are given", () => {
    expect(buildMetricBoolQuery({})).toEqual({ match_all: {} });
  });

  it("builds a term filter on the flat app_name attribute for --service", () => {
    expect(buildMetricBoolQuery({ service: "my-app" })).toEqual({
      bool: { filter: [{ term: { "resource.attributes.sap@cf@app_name": "my-app" } }] },
    });
  });

  /**
   * A metric name does not always identify one series. Cloud Foundry publishes
   * `container.cpu.usage` twice — `unit="1"` (fraction of the app's CPU
   * entitlement) and `unit="cpu"` (fraction of one core) — differing by ~17x,
   * confirmed live. Without this filter, `history`/`top` average the two into a
   * number with no physical meaning, and the blend looks entirely plausible.
   */
  it("builds a term filter on unit, so a multi-unit metric name can be narrowed to one series", () => {
    expect(buildMetricBoolQuery({ unit: "cpu" })).toEqual({
      bool: { filter: [{ term: { unit: "cpu" } }] },
    });
  });

  it("combines the unit filter with service, name and time filters", () => {
    const query = buildMetricBoolQuery({
      service: "my-app",
      names: ["container.cpu.usage"],
      unit: "1",
      since: "2026-08-31T10:00:00.000Z",
    }) as { bool: { filter: Record<string, unknown>[] } };

    expect(query.bool.filter).toContainEqual({ term: { unit: "1" } });
    expect(query.bool.filter).toHaveLength(4);
  });

  it("builds a terms filter for one or more metric names", () => {
    const query = buildMetricBoolQuery({ names: ["container.cpu.usage", "container.memory.usage"] }) as {
      bool: { filter: unknown[] };
    };
    expect(query.bool.filter).toContainEqual({ terms: { name: ["container.cpu.usage", "container.memory.usage"] } });
  });

  it("omits the names filter when given an empty array", () => {
    expect(buildMetricBoolQuery({ names: [] })).toEqual({ match_all: {} });
  });

  it("builds a plain range filter on time with no unmapped_type — range rejects that option", () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    const query = buildMetricBoolQuery({ since: "2h", until: "1h" }, now) as { bool: { filter: unknown[] } };
    expect(query.bool.filter).toContainEqual({
      range: { time: { gte: "2026-08-31T10:00:00.000Z", lte: "2026-08-31T11:00:00.000Z" } },
    });
  });

  it("builds a range filter with only gte when --until is omitted", () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    const query = buildMetricBoolQuery({ since: "1h" }, now) as { bool: { filter: unknown[] } };
    expect(query.bool.filter).toContainEqual({ range: { time: { gte: "2026-08-31T11:00:00.000Z" } } });
  });

  it("combines service, names, and time range filters together", () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    const query = buildMetricBoolQuery(
      { service: "my-app", names: ["container.cpu.usage"], since: "1h" },
      now,
    ) as { bool: { filter: unknown[] } };
    expect(query.bool.filter).toHaveLength(3);
  });
});
