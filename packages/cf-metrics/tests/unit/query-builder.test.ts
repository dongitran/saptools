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

  it("reports an out-of-range relative duration as a config error rather than a bare RangeError", () => {
    // `new Date(...).toISOString()` throws "RangeError: Invalid time value" here,
    // which the CLI printed with no flag, no value and no way to act on it.
    expect(() => {
      resolveTimeBound("999999999999d");
    }).toThrow(/beyond the range of a real date/);
  });

  it("passes an absolute value through untouched even when it is not a shape the flags accept", () => {
    // `watch` re-feeds a fetched document's own `time` value back through here on
    // every poll. Validating the absolute branch would turn a shape this pattern
    // happens not to cover into a fatal crash of a long-running loop.
    expect(resolveTimeBound("2026-02-30")).toBe("2026-02-30");
    expect(resolveTimeBound("whatever the backend wrote")).toBe("whatever the backend wrote");
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

  /**
   * `Date.parse` rejects month 13 and day 00 but rolls a day past its own
   * month's end silently forward, so these all read as valid to it. Measured
   * against a real Cloud Logging instance: every one of them is rejected by the
   * `strict_date_optional_time||epoch_millis` mapping, so forwarding one buys a
   * parse-exception dump after a full login instead of an instant local error.
   */
  it.each(["2026-02-30", "2026-04-31", "2026-06-31", "2026-09-31", "2026-11-31"])(
    "rejects %s, a day past the end of its own month",
    (value) => {
      expect(() => {
        assertValidTimeBoundShape("--since", value);
      }).toThrow(/not a real calendar date/);
    },
  );

  it("applies the leap-year rules rather than assuming February always has 28 days", () => {
    expect(() => {
      assertValidTimeBoundShape("--since", "2024-02-29");
    }).not.toThrow();
    expect(() => {
      assertValidTimeBoundShape("--since", "2000-02-29");
    }).not.toThrow();
    expect(() => {
      assertValidTimeBoundShape("--since", "2025-02-29");
    }).toThrow(/month 02 of 2025 has 28 days/);
    // 1900 is divisible by 4 but not 400, so it is not a leap year.
    expect(() => {
      assertValidTimeBoundShape("--since", "1900-02-29");
    }).toThrow(/month 02 of 1900 has 28 days/);
  });

  it("keeps a year below 100 out of Date.UTC's two-digit-year mapping", () => {
    // `Date.UTC(0, 1, 29)` maps year 0 into 1900, which is not a leap year — so
    // probing it for February's length would reject this real date.
    expect(() => {
      assertValidTimeBoundShape("--since", "0000-02-29");
    }).not.toThrow();
    expect(() => {
      assertValidTimeBoundShape("--since", "0000-02-30");
    }).toThrow(/month 02 of 0000 has 29 days/);
  });

  it("checks the calendar day on a timestamp carrying a timezone offset, not only a date-only value", () => {
    expect(() => {
      assertValidTimeBoundShape("--until", "2026-02-30T00:00:00+07:00");
    }).toThrow(/not a real calendar date/);
  });

  it("echoes the month and year exactly as typed rather than reformatting them", () => {
    // Read back as numbers, "0000" would print as "0" and "02" as "2".
    expect(() => {
      assertValidTimeBoundShape("--since", "0000-02-30");
    }).toThrow(/month 02 of 0000/);
  });

  /**
   * Each of these was measured against the real backend rather than assumed:
   * the space form, hour 24, minute/second 60 and a tenth fractional digit are
   * all rejected by `strict_date_optional_time`, so accepting them locally only
   * defers the same failure to a slower, less legible place.
   */
  it.each([
    ["a space instead of T", "2026-08-30 03:00:00"],
    ["hour 24, which ISO-8601 allows as end-of-day but java.time resolves strictly", "2026-08-30T24:00:00Z"],
    ["minute 60", "2026-08-30T03:60:00Z"],
    ["second 60", "2026-08-30T03:00:60Z"],
    ["a tenth fractional digit, past the mapping's nanosecond cap", "2026-08-30T03:00:00.1234567890Z"],
  ])("rejects %s", (_label, value) => {
    expect(() => {
      assertValidTimeBoundShape("--since", value);
    }).toThrow(/Invalid --since value/);
  });

  /**
   * The mirror of the block above, and just as important: a shape the backend
   * accepts must not be refused locally, or the check removes a capability
   * instead of protecting one. All three were measured as accepted.
   */
  it.each([
    ["hour and minute, no seconds", "2026-08-30T03:00"],
    ["an offset without a colon", "2026-08-30T03:00:00+0700"],
    ["nine fractional digits", "2026-08-30T03:00:00.123456789Z"],
  ])("accepts %s, which the backend accepts", (_label, value) => {
    expect(() => {
      assertValidTimeBoundShape("--since", value);
    }).not.toThrow();
  });

  /**
   * These three the backend *does* accept, and we still refuse — the one place
   * this validator is deliberately narrower than OpenSearch. `Date.parse`
   * returns NaN for all three, and `assertValidTimeRange` compares bounds
   * through `Date.parse`, so accepting them would not widen what works: it
   * would quietly switch off the inverted-window check for anyone who used
   * them. Widening the pattern here without also fixing that comparison would
   * trade a loud refusal for a silent hole.
   */
  it.each([
    ["hour only", "2026-08-30T03"],
    ["hour only with a zone", "2026-08-30T03Z"],
    ["a comma as the fraction separator", "2026-08-30T03:00:00,123Z"],
  ])("refuses %s, which the backend accepts but Date.parse cannot read", (_label, value) => {
    expect(Number.isNaN(Date.parse(value))).toBe(true);
    expect(() => {
      assertValidTimeBoundShape("--since", value);
    }).toThrow(/Invalid --since value/);
  });

  it("rejects a relative duration too large to land on a real date, naming the flag", () => {
    // Left to `resolveTimeBound` this surfaced as a bare "Invalid time value"
    // RangeError naming neither the flag nor the value — and for a command with
    // no --until, only after the full login this check exists to precede.
    expect(() => {
      assertValidTimeBoundShape("--lookback", "999999999999d");
    }).toThrow(/--lookback[\s\S]*beyond the range of a real date/);
  });

  it("explains both readings of a bare number instead of only naming durations", () => {
    // The mapping is `strict_date_optional_time||epoch_millis` (measured), so a
    // bare number is genuinely ambiguous rather than simply wrong.
    expect(() => {
      assertValidTimeBoundShape("--since", "1788538702171");
    }).toThrow(/bare number is ambiguous/);
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

  /**
   * The ordering check compares resolved instants, and `Date.parse` resolves
   * "2026-02-30" to March 2 — which really is later than March 1. So a
   * calendar typo used to come back as a confident "--since is later than
   * --until", sending the reader to fix the flag that was never wrong. The
   * shape check has to win, and this pins that it does.
   */
  it("reports a calendar-invalid --since as a bad date, not as an inverted range", () => {
    expect(() => {
      assertValidTimeRange({ since: "2026-02-30", until: "2026-03-01" }, undefined, NOW);
    }).toThrow(/not a real calendar date/);
    expect(() => {
      assertValidTimeRange({ since: "2026-02-30", until: "2026-03-01" }, undefined, NOW);
    }).not.toThrow(/is later than --until/);
  });

  it("rejects a calendar-invalid --until that would otherwise pass the ordering check", () => {
    // Rolled forward to March 2, this reads as a perfectly ordered window.
    expect(() => {
      assertValidTimeRange({ since: "2026-01-31", until: "2026-02-30" }, undefined, NOW);
    }).toThrow(/not a real calendar date/);
  });
});
