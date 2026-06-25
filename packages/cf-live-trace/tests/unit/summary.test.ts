import { describe, expect, it } from "vitest";

import { buildUrlSummaries, normalizeEventUrl } from "../../src/summary.js";
import type { LiveTraceEvent } from "../../src/types.js";

describe("URL summaries", () => {
  it("aggregates method and status buckets by normalized URL", () => {
    const summaries = buildUrlSummaries([
      createEvent("1", "GET", "/odata/v4/orders?$top=5", 200, "2026-06-18T07:22:10.000Z"),
      createEvent("2", "POST", "/odata/v4/orders?$top=5", 201, "2026-06-18T07:22:11.000Z"),
      createEvent("3", "GET", "/health", 503, "2026-06-18T07:22:09.000Z"),
    ]);

    expect(summaries[0]).toEqual(
      expect.objectContaining({
        normalizedUrl: "/odata/v4/orders?$top=5",
        methods: ["GET", "POST"],
        totalCount: 2,
        latestStatus: 201,
        statusCounts: expect.objectContaining({ "2xx": 2 }),
      }),
    );
    expect(summaries[1]).toEqual(
      expect.objectContaining({
        normalizedUrl: "/health",
        statusCounts: expect.objectContaining({ "5xx": 1 }),
      }),
    );
  });

  it("normalizes absolute URLs back to path and query", () => {
    expect(normalizeEventUrl(createEvent("1", "GET", "https://example.com/foo?bar=1", null))).toBe("/foo?bar=1");
  });

  it("handles empty, malformed, redirect, client-error, and unknown statuses", () => {
    const summaries = buildUrlSummaries([
      { ...createEvent("1", "GET", "", null), normalizedUrl: "", url: "", path: "" },
      createEvent("2", "GET", "not a url with spaces", 302),
      createEvent("3", "GET", "/bad-request", 404),
      createEvent("4", "GET", "/odd", 700),
    ]);

    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ normalizedUrl: "", statusCounts: expect.objectContaining({ unknown: 1 }) }),
        expect.objectContaining({ normalizedUrl: "/not%20a%20url%20with%20spaces", statusCounts: expect.objectContaining({ "3xx": 1 }) }),
        expect.objectContaining({ normalizedUrl: "/bad-request", statusCounts: expect.objectContaining({ "4xx": 1 }) }),
        expect.objectContaining({ normalizedUrl: "/odd", statusCounts: expect.objectContaining({ unknown: 1 }) }),
      ]),
    );
  });
});

function createEvent(
  id: string,
  method: string,
  url: string,
  status: number | null,
  timestamp = "2026-06-18T07:22:10.000Z",
): LiveTraceEvent {
  return {
    id,
    timestamp,
    appId: "orders-api",
    instance: "0",
    method,
    path: url.split("?")[0] ?? url,
    url,
    normalizedUrl: url,
    status,
    durationMs: 42,
    requestBytes: 0,
    responseBytes: 0,
    requestHeaders: {},
    responseHeaders: {},
    requestBodyPreview: "",
    responseBodyPreview: "",
    requestBodyTruncated: false,
    responseBodyTruncated: false,
    droppedBeforeEvent: 0,
    source: "runtime-http",
    traceId: id,
    correlationId: null,
  };
}
