import { describe, expect, it } from "vitest";

import { CfOtelError } from "../../src/errors.js";
import { assertTimeBoundsValid, buildSpanBoolQuery, resolveTimeBound } from "../../src/query-builder.js";

/** Capture a thrown {@link CfOtelError} so a test can assert on its `code` as well as its message. */
function captureError(run: () => unknown): CfOtelError {
  try {
    run();
  } catch (error) {
    if (error instanceof CfOtelError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to throw, but it returned normally");
}

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

  it("preserves nanosecond precision byte-for-byte instead of round-tripping through Date", () => {
    // `startTime` is a date_nanos field; normalizing through Date would
    // silently truncate these nine fractional digits to three.
    const nanos = "2026-08-28T03:05:46.542228853Z";
    expect(resolveTimeBound(nanos, now)).toBe(nanos);
  });

  it.each(["2026-08-28", "2026-08-28T03:00Z", "2026-08-28T03:00:00+02:00", "2026-08-28T03:00:00-05:30"])(
    "accepts the optional-precision ISO form %s",
    (value) => {
      expect(resolveTimeBound(value, now)).toBe(value);
    },
  );

  it("accepts February 29 in a leap year", () => {
    expect(resolveTimeBound("2024-02-29", now)).toBe("2024-02-29");
  });
});

describe("resolveTimeBound validation", () => {
  const now = new Date("2026-08-29T12:00:00.000Z");

  it("rejects a relative duration too large to resolve to a real date", () => {
    // Before this guard, `new Date(...).toISOString()` threw a bare
    // `RangeError: Invalid time value` that the CLI printed with no hint at
    // which flag produced it.
    const error = captureError(() => resolveTimeBound("999999999d", now, "--since"));
    expect(error.code).toBe("CONFIG");
    expect(error.message).toContain("--since");
    expect(error.message).toContain("999999999d");
    expect(error.message).toContain("smaller relative duration");
  });

  it("still rejects an out-of-range duration when no flag name is supplied", () => {
    expect(() => resolveTimeBound("99999999999999999999d", now)).toThrow(/time bound/);
  });

  it.each(["garbage", "yesterday", "now", "last week"])("rejects the free-text bound %s", (value) => {
    const error = captureError(() => resolveTimeBound(value, now, "--until"));
    expect(error.code).toBe("CONFIG");
    expect(error.message).toContain("--until");
    expect(error.message).toContain("is not a valid time bound");
  });

  it.each(["24hh", "1w", "24H", "h", "-1h", "1.5h", ""])("rejects the near-miss duration %j", (value) => {
    expect(() => resolveTimeBound(value, now, "--since")).toThrow(/not a valid time bound/);
  });

  it("spells out the accepted grammar so the message is actionable on its own", () => {
    const error = captureError(() => resolveTimeBound("yesterday", now, "--since"));
    expect(error.message).toContain("24h");
    expect(error.message).toContain("units s, m, h, d");
    expect(error.message).toContain("2026-08-28T03:00:00Z");
  });

  it("rejects a month outside 1-12", () => {
    expect(() => resolveTimeBound("2026-13-45", now, "--since")).toThrow(/not a valid time bound/);
  });

  it.each([
    ["2026-02-30", 28],
    ["2026-02-29", 28],
    ["2026-04-31", 30],
    ["2026-06-31", 30],
  ])("rejects %s, which Date.parse would silently roll over into the next month", (value, days) => {
    // OpenSearch's strict_date_optional_time rejects these outright, so
    // forwarding one would turn a typo into an HTTP 400 dump.
    const error = captureError(() => resolveTimeBound(value, now, "--since"));
    expect(error.code).toBe("CONFIG");
    expect(error.message).toContain("not a real calendar date");
    expect(error.message).toContain(`has ${String(days)} days`);
  });

  it.each(["Aug 28 2026", "2026-08-28 03:00:00", "08/28/2026"])(
    "rejects %j even though Date.parse accepts it, because OpenSearch does not",
    (value) => {
      expect(() => resolveTimeBound(value, now, "--since")).toThrow(/not a valid time bound/);
    },
  );

  it("explains both readings of a bare number instead of picking one", () => {
    // The index accepts epoch_millis, so a number that was never checked used to reach
    // OpenSearch and work. It stays rejected because "--since 24" reads just
    // as easily as a "24h" missing its unit, and as an epoch-millis lower
    // bound it would quietly match the entire index.
    const error = captureError(() => resolveTimeBound("1788425000000", new Date(), "--since"));
    expect(error.code).toBe("CONFIG");
    expect(error.message).toContain("A bare number is ambiguous here");
    expect(error.message).toContain('"1788425000000h"');
    expect(error.message).toContain("epoch milliseconds");
  });

  it("gives the same ambiguity hint for a short bare number", () => {
    expect(() => resolveTimeBound("24", new Date(), "--since")).toThrow(/add a unit for a relative duration \("24h"\)/);
  });

  it("does not add the number hint to a non-numeric bound", () => {
    const error = captureError(() => resolveTimeBound("garbage", new Date(), "--since"));
    expect(error.message).not.toContain("bare number");
  });

  it.each(["2000-02-29", "2024-02-29", "0000-02-29", "0004-02-29", "2026-01-31", "2026-12-31"])(
    "accepts the real calendar date %s",
    (value) => {
      expect(resolveTimeBound(value, new Date())).toBe(value);
    },
  );

  it.each(["1900-02-29", "2100-02-29", "0100-02-29", "0000-02-30"])(
    "rejects %s, which is not a leap-year February",
    (value) => {
      expect(() => resolveTimeBound(value, new Date(), "--since")).toThrow(/not a real calendar date/);
    },
  );

  it("keeps a year below 100 out of Date.UTC's two-digit-year mapping", () => {
    // `Date.UTC(0, 2, 0)` lands on 1900-02-28, so probing month length with
    // the caller's year would report year 0 as having a 28-day February and
    // reject the real date 0000-02-29.
    expect(resolveTimeBound("0000-02-29", new Date())).toBe("0000-02-29");
    const error = captureError(() => resolveTimeBound("0000-02-30", new Date(), "--since"));
    expect(error.message).toContain("month 02 of 0000 has 29 days");
  });

  it("echoes the year and month as typed rather than reformatting them", () => {
    const error = captureError(() => resolveTimeBound("2026-02-30", new Date(), "--since"));
    expect(error.message).toContain("month 02 of 2026 has 28 days");
  });

  it("trims surrounding whitespace before validating", () => {
    expect(resolveTimeBound("  24h  ", now)).toBe("2026-08-28T12:00:00.000Z");
    expect(resolveTimeBound("  2026-08-28T03:00:00Z  ", now)).toBe("2026-08-28T03:00:00Z");
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

  it("offers both encodings for = at every text-like mapped type", () => {
    for (const mappedType of [
      "keyword",
      "text",
      "wildcard",
      "constant_keyword",
      "match_only_text",
      "version",
      "search_as_you_type",
      "annotated_text",
    ]) {
      const query = buildSpanBoolQuery({
        attrs: [{
          key: "span.attributes.http@request@header@x-vcap-request-id",
          operator: "=",
          value: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          mappedType,
        }],
      }) as { bool: { filter: unknown[] } };

      expect(query.bool.filter, mappedType).toContainEqual({
        terms: {
          "span.attributes.http@request@header@x-vcap-request-id": [
            "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            '["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]',
          ],
        },
      });
    }
  });

  it("escapes the array-rendered alternative as JSON rather than by concatenation", () => {
    const query = buildSpanBoolQuery({
      attrs: [{ key: "k", operator: "=", value: 'a"b\\c', mappedType: "keyword" }],
    }) as { bool: { filter: Record<string, { k: string[] }>[] } };

    const values = query.bool.filter[0]?.["terms"]?.k;
    // The concrete string, not a round trip through the same function that
    // produced it — otherwise the assertion could not fail.
    expect(values?.[1]).toBe('["a\\"b\\\\c"]');
    // What naive `\`["${value}"]\`` concatenation would have produced. Sending
    // that would be a different term and would silently match nothing.
    expect(values?.[1]).not.toBe('["a"b\\c"]');
  });

  it("never sends the array-rendered alternative at a numeric field", () => {
    // Not a style choice: an extra ["500"] term at an integer field fails the
    // whole search with HTTP 400 instead of simply not matching.
    for (const mappedType of ["integer", "long", "date", "date_nanos", "ip", "boolean", "float", "token_count"]) {
      const query = buildSpanBoolQuery({
        attrs: [{ key: "span.attributes.http@response@status_code", operator: "=", value: "500", mappedType }],
      }) as { bool: { filter: unknown[] } };

      expect(query.bool.filter, mappedType).toContainEqual({
        term: { "span.attributes.http@response@status_code": "500" },
      });
      expect(query.bool.filter, mappedType).not.toContainEqual({
        terms: { "span.attributes.http@response@status_code": ["500", '["500"]'] },
      });
    }
  });

  it("stays on a plain term when the field is unmapped", () => {
    const query = buildSpanBoolQuery({
      attrs: [{ key: "custom@thing", operator: "=", value: "x" }],
    }) as { bool: { filter: unknown[] } };

    expect(query.bool.filter).toContainEqual({ term: { "custom@thing": "x" } });
  });

  it("folds a hex request id to lower case and trims it", () => {
    // keyword matching is exact and every stored id sampled from a live index
    // was lower-case hex, so an id pasted in upper case used to match nothing.
    const query = buildSpanBoolQuery({ vcapRequestId: "  AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE \n" }) as {
      bool: { filter: unknown[] };
    };

    expect(query.bool.filter).toContainEqual({
      terms: {
        "span.attributes.http@request@header@x-vcap-request-id": [
          "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          '["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]',
        ],
      },
    });
  });

  it("leaves a non-hex identifier's case alone rather than guessing", () => {
    const query = buildSpanBoolQuery({ vcapRequestId: " MixedCaseId " }) as { bool: { filter: unknown[] } };

    expect(query.bool.filter).toContainEqual({
      terms: {
        "span.attributes.http@request@header@x-vcap-request-id": ["MixedCaseId", '["MixedCaseId"]'],
      },
    });
  });

  it("resolves a Cloud Foundry request id in both stored encodings", () => {
    const query = buildSpanBoolQuery({ vcapRequestId: "11111111-2222-4333-8444-555555555555" }) as {
      bool: { filter: unknown[] };
    };

    expect(query.bool.filter).toContainEqual({
      terms: {
        "span.attributes.http@request@header@x-vcap-request-id": [
          "11111111-2222-4333-8444-555555555555",
          '["11111111-2222-4333-8444-555555555555"]',
        ],
      },
    });
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

  it("names --since when the invalid bound is --since", () => {
    const error = captureError(() => buildSpanBoolQuery({ since: "yesterday" }));
    expect(error.message).toContain("--since");
    expect(error.message).not.toContain("--until");
  });

  it("names --until when the invalid bound is --until", () => {
    const error = captureError(() => buildSpanBoolQuery({ until: "nope" }));
    expect(error.message).toContain("--until");
    expect(error.message).not.toContain("--since");
  });
});

describe("buildSpanBoolQuery time range ordering", () => {
  const now = new Date("2026-08-29T12:00:00.000Z");

  it("rejects a swapped relative range, which would otherwise match nothing silently", () => {
    // "--since 1h --until 2h" reads naturally but means "from an hour ago
    // until two hours ago" — an empty window indistinguishable from no data.
    const error = captureError(() => buildSpanBoolQuery({ since: "1h", until: "2h" }, now));
    expect(error.code).toBe("CONFIG");
    expect(error.message).toContain("is after --until");
    expect(error.message).toContain("would match nothing");
  });

  it("rejects a swapped absolute range", () => {
    expect(() =>
      buildSpanBoolQuery({ since: "2026-08-28T10:00:00Z", until: "2026-08-28T09:00:00Z" }, now),
    ).toThrow(/is after --until/);
  });

  it("accepts a correctly ordered relative range", () => {
    const query = buildSpanBoolQuery({ since: "2h", until: "1h" }, now) as { bool: { filter: unknown[] } };
    expect(query.bool.filter).toContainEqual({
      range: { startTime: { gte: "2026-08-29T10:00:00.000Z", lte: "2026-08-29T11:00:00.000Z" } },
    });
  });

  it("accepts a relative since paired with an absolute until", () => {
    const query = buildSpanBoolQuery({ since: "24h", until: "2026-08-29T06:00:00Z" }, now) as {
      bool: { filter: unknown[] };
    };
    expect(query.bool.filter).toContainEqual({
      range: { startTime: { gte: "2026-08-28T12:00:00.000Z", lte: "2026-08-29T06:00:00Z" } },
    });
  });

  it("accepts a zero-width range where both bounds are equal", () => {
    expect(() =>
      buildSpanBoolQuery({ since: "2026-08-28T10:00:00Z", until: "2026-08-28T10:00:00Z" }, now),
    ).not.toThrow();
  });

  it("still builds a one-sided range when only --since is given", () => {
    const query = buildSpanBoolQuery({ since: "1h" }, now) as { bool: { filter: unknown[] } };
    expect(query.bool.filter).toContainEqual({ range: { startTime: { gte: "2026-08-29T11:00:00.000Z" } } });
  });

  it("still builds a one-sided range when only --until is given", () => {
    const query = buildSpanBoolQuery({ until: "1h" }, now) as { bool: { filter: unknown[] } };
    expect(query.bool.filter).toContainEqual({ range: { startTime: { lte: "2026-08-29T11:00:00.000Z" } } });
  });
});

describe("assertTimeBoundsValid", () => {
  const now = new Date("2026-08-29T12:00:00.000Z");

  it("accepts a valid pair without throwing", () => {
    expect(() => {
      assertTimeBoundsValid({ since: "24h", until: "1h" }, now);
    }).not.toThrow();
  });

  it("is a no-op when neither bound is given", () => {
    expect(() => {
      assertTimeBoundsValid({}, now);
    }).not.toThrow();
  });

  it.each([
    [{ since: "yesterday" }, /--since/],
    [{ until: "nope" }, /--until/],
    [{ since: "999999999d" }, /smaller relative duration/],
    [{ since: "2026-02-30" }, /not a real calendar date/],
    [{ since: "1h", until: "2h" }, /is after --until/],
  ])("rejects %j the same way the query builder does", (opts, expected) => {
    expect(() => {
      assertTimeBoundsValid(opts, now);
    }).toThrow(expected);
  });

  it("agrees with buildSpanBoolQuery on every bound it is given", () => {
    // The early check exists only to fail fast; if the two could ever disagree,
    // a command would pass validation and then throw after a full CF login.
    for (const value of ["24h", "2026-08-28", "garbage", "2026-02-30", "999999999d", "24", ""]) {
      let earlyMessage: string | undefined;
      let builderMessage: string | undefined;
      try {
        assertTimeBoundsValid({ since: value }, now);
      } catch (error) {
        earlyMessage = error instanceof Error ? error.message : String(error);
      }
      try {
        buildSpanBoolQuery({ since: value }, now);
      } catch (error) {
        builderMessage = error instanceof Error ? error.message : String(error);
      }
      expect(earlyMessage).toBe(builderMessage);
    }
  });
});
