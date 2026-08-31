import { describe, expect, it } from "vitest";

import { assertValidTimeBoundShape, assertValidTimeRange, buildMetricBoolQuery, resolveTimeBound } from "../../src/query-builder.js";

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

describe("assertValidTimeRange", () => {
  const NOW = new Date("2026-09-01T12:00:00.000Z");

  /**
   * OpenSearch accepts `{gte: <later>, lte: <earlier>}` and simply matches
   * nothing, so before this guard the command exited 0 with an empty table —
   * indistinguishable from a genuinely quiet period.
   */
  it("rejects a window whose --since is later than its --until", () => {
    expect(() => {
      assertValidTimeRange({ since: "30m", until: "2h" }, undefined, NOW);
    }).toThrow(/--since "30m" is later than --until "2h"/);
  });

  /**
   * The nastier shape: the user wrote nothing contradictory. `--until 3h` alone
   * inverted against the command's own 2h default and returned nothing.
   */
  it("rejects an --until older than the defaulted --since, and blames the default", () => {
    expect(() => {
      assertValidTimeRange({ until: "3h" }, "2h", NOW);
    }).toThrow(/older than the default --since \("2h"\)/);
  });

  it("accepts a window in the past where --since is the older bound", () => {
    expect(() => {
      assertValidTimeRange({ since: "4h", until: "3h" }, "2h", NOW);
    }).not.toThrow();
  });

  it("accepts --until alone for a command that leaves the start unbounded", () => {
    expect(() => {
      assertValidTimeRange({ until: "3h" }, undefined, NOW);
    }).not.toThrow();
  });

  it("accepts an equal start and end rather than inventing an error for a legal point query", () => {
    expect(() => {
      assertValidTimeRange({ since: "1h", until: "1h" }, undefined, NOW);
    }).not.toThrow();
  });

  it("compares absolute timestamps, not just relative durations", () => {
    expect(() => {
      assertValidTimeRange({ since: "2026-09-01T10:00:00Z", until: "2026-08-01T10:00:00Z" }, undefined, NOW);
    }).toThrow(/is later than --until/);
  });

  it("compares a relative bound against an absolute one", () => {
    // 30m before NOW is 11:30; the absolute --until is an hour earlier.
    expect(() => {
      assertValidTimeRange({ since: "30m", until: "2026-09-01T10:30:00Z" }, undefined, NOW);
    }).toThrow(/is later than --until/);
  });

  it("still reports a malformed bound as a shape error rather than an ordering one", () => {
    expect(() => {
      assertValidTimeRange({ since: "yesterday", until: "3h" }, undefined, NOW);
    }).toThrow(/Invalid --since value "yesterday"/);
  });

  it("does nothing when no --until is given", () => {
    expect(() => {
      assertValidTimeRange({ since: "30m" }, "2h", NOW);
    }).not.toThrow();
  });
});
