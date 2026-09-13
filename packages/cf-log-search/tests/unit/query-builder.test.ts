import { describe, expect, it } from "vitest";

import { buildSearchQuery, resolveTimeBound, resolveTimeRange } from "../../src/query-builder.js";

const NOW = new Date("2026-09-12T06:00:00.000Z");

describe("resolveTimeBound", () => {
  it("resolves a relative duration against the given 'now'", () => {
    expect(resolveTimeBound("1h", "--since", NOW)).toBe(new Date("2026-09-12T05:00:00.000Z").toISOString());
  });

  it("passes an absolute ISO instant through verbatim, not round-tripped through Date", () => {
    expect(resolveTimeBound("2026-09-01T00:00:00.123456789Z", "--since", NOW)).toBe("2026-09-01T00:00:00.123456789Z");
  });

  it("rejects an invalid day-of-month that Date.parse would silently roll over", () => {
    // Date.parse("2026-02-30") rolls forward to March 2 — OpenSearch's strict_date_optional_time rejects it outright.
    expect(() => resolveTimeBound("2026-02-30", "--since", NOW)).toThrow(/invalid day/);
  });

  it("rejects an invalid month", () => {
    expect(() => resolveTimeBound("2026-13-01", "--since", NOW)).toThrow(/invalid month/);
  });

  it("accepts February 29 on a leap year and rejects it on a non-leap year", () => {
    expect(() => resolveTimeBound("2028-02-29", "--since", NOW)).not.toThrow();
    expect(() => resolveTimeBound("2026-02-29", "--since", NOW)).toThrow(/invalid day/);
  });

  it("rejects garbage input with the flag name in the message", () => {
    expect(() => resolveTimeBound("garbage", "--until", NOW)).toThrow(/--until "garbage"/);
  });

  it("returns undefined when the value itself is undefined", () => {
    expect(resolveTimeBound(undefined, "--since", NOW)).toBeUndefined();
  });
});

describe("resolveTimeRange", () => {
  it("defaults --since to 1h when neither is given", () => {
    const range = resolveTimeRange(undefined, undefined, () => NOW);
    expect(range).toEqual({ gte: new Date("2026-09-12T05:00:00.000Z").toISOString() });
  });

  it("throws when --since is later than --until", () => {
    expect(() => resolveTimeRange("2026-09-12T05:00:00Z", "2026-09-12T04:00:00Z", () => NOW)).toThrow(
      /--since .* is later than --until/,
    );
  });
});

describe("buildSearchQuery", () => {
  it("builds a bool query with a time-range filter and no other filters", () => {
    const query = buildSearchQuery({}, () => NOW);
    expect(query).toEqual({ bool: { filter: [{ range: { "@timestamp": { gte: new Date("2026-09-12T05:00:00.000Z").toISOString() } } }] } });
  });

  it("adds a term filter on the .keyword sub-field for app/space/level/sourceType", () => {
    const query = buildSearchQuery({ app: "acme-svc-config", space: "app", level: "error", sourceType: "RTR" }, () => NOW) as { bool: { filter: unknown[] } };
    expect(query.bool.filter).toContainEqual({ term: { "app_name.keyword": "acme-svc-config" } });
    expect(query.bool.filter).toContainEqual({ term: { "space_name.keyword": "app" } });
    expect(query.bool.filter).toContainEqual({ term: { "level.keyword": "error" } });
    expect(query.bool.filter).toContainEqual({ term: { "source_type.keyword": "RTR" } });
  });

  it("filters on vcap_request_id.keyword and correlation_id.keyword exactly, never analyzed text", () => {
    const query = buildSearchQuery({ vcapRequestId: "11111111-1111-4111-8111-111111111111", correlationId: "22222222-2222-4222-8222-222222222222" }, () => NOW) as {
      bool: { filter: unknown[] };
    };
    expect(query.bool.filter).toContainEqual({ term: { "vcap_request_id.keyword": "11111111-1111-4111-8111-111111111111" } });
    expect(query.bool.filter).toContainEqual({ term: { "correlation_id.keyword": "22222222-2222-4222-8222-222222222222" } });
  });

  it("filters response_status as a numeric term, not a string", () => {
    const query = buildSearchQuery({ status: 500 }, () => NOW) as { bool: { filter: unknown[] } };
    expect(query.bool.filter).toContainEqual({ term: { response_status: 500 } });
  });

  it("adds a match clause on msg (analyzed text) for --query, under must, not filter", () => {
    const query = buildSearchQuery({ query: "connection refused" }, () => NOW) as { bool: { must: unknown[] } };
    expect(query.bool.must).toContainEqual({ match: { msg: "connection refused" } });
  });
});
