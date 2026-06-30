import { describe, expect, it } from "vitest";

import { detectBodyFormat } from "../../src/trace-compact.js";
import { inspectTraceBody, searchTraceRecords } from "../../src/trace-inspect.js";
import type { StoredTraceEvent } from "../../src/trace-store.js";
import type { LiveTraceEvent } from "../../src/types.js";

describe("trace body inspection", () => {
  it("inspects a selected JSON pointer with bounded values", () => {
    const record = createStoredEvent();

    const rows = inspectTraceBody(record, {
      body: "response",
      path: "/data",
      limit: 12,
    });

    expect(rows).toEqual([
      { path: "/data/name", type: "string", value: "alpha-value-" },
      { path: "/data/items", type: "array", value: "items=2" },
    ]);
  });

  it("searches JSON keys and values across saved request and response bodies", () => {
    const matches = searchTraceRecords([createStoredEvent()], "alpha", {
      body: "both",
      limit: 10,
      previewLength: 20,
    });

    expect(matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: "r12345678", body: "request", path: "/filter", preview: "alpha" }),
      expect.objectContaining({ requestId: "r12345678", body: "response", path: "/data/name", preview: "alpha-value-12345678" }),
    ]));
  });

  it("handles arrays, scalar JSON paths, plain text search, and invalid input", () => {
    const arrayRecord = createStoredEvent({
      responseBodyPreview: "[{\"name\":\"alpha\"},{\"name\":\"beta\"}]",
      responseBodyFormat: "json",
    });
    const textRecord = createStoredEvent({
      responseBodyPreview: "prefix alpha suffix",
      responseBodyFormat: "text",
    });

    expect(inspectTraceBody(arrayRecord, { body: "response", path: "", limit: 20 })).toEqual([
      { path: "/0", type: "object", value: "keys=1" },
      { path: "/1", type: "object", value: "keys=1" },
    ]);
    expect(inspectTraceBody(arrayRecord, { body: "response", path: "/0/name", limit: 3 })).toEqual([
      { path: "/0/name", type: "string", value: "alp" },
    ]);
    expect(searchTraceRecords([textRecord], "alpha", { body: "response", limit: 1, previewLength: 10 })).toEqual([
      expect.objectContaining({ body: "response", path: "", offset: 7, preview: "prefix alp" }),
    ]);
    expect(() => inspectTraceBody(arrayRecord, { body: "response", path: "name", limit: 20 })).toThrow("JSON Pointer");
    expect(() => inspectTraceBody(arrayRecord, { body: "response", path: "/2", limit: 20 })).toThrow("not found");
    expect(() => inspectTraceBody(textRecord, { body: "response", path: "", limit: 20 })).toThrow("valid JSON");
    expect(() => searchTraceRecords([arrayRecord], " ", { body: "both", limit: 1 })).toThrow("search text");
  });
});

function createStoredEvent(overrides: Partial<StoredTraceEvent> & Partial<LiveTraceEvent> = {}): StoredTraceEvent {
  const event: LiveTraceEvent = {
    id: "runtime-1",
    timestamp: "2026-06-30T01:00:00.000Z",
    appId: "orders-api",
    instance: "0",
    method: "POST",
    path: "/orders",
    url: "/orders",
    normalizedUrl: "/orders",
    status: 201,
    durationMs: 42,
    requestBytes: 64,
    responseBytes: 128,
    requestHeaders: { "content-type": "application/json" },
    responseHeaders: { "content-type": "application/json" },
    requestBodyPreview: "{\"filter\":\"alpha\"}",
    responseBodyPreview: "{\"data\":{\"name\":\"alpha-value-1234567890\",\"items\":[1,2]}}",
    requestBodyTruncated: false,
    responseBodyTruncated: false,
    droppedBeforeEvent: 0,
    source: "runtime-http",
    traceId: "runtime-1",
    correlationId: null,
    ...overrides,
  };
  return {
    version: 1,
    sessionId: "s12345678",
    requestId: "r12345678",
    createdAt: "2026-06-30T01:00:00.000Z",
    expiresAt: "2026-06-30T03:00:00.000Z",
    target: {
      region: "ap10",
      org: "sample-org",
      space: "dev",
      app: "orders-api",
      instance: "0",
    },
    requestBodyFormat: overrides.requestBodyFormat ?? detectBodyFormat(event.requestBodyPreview, event.requestHeaders),
    responseBodyFormat: overrides.responseBodyFormat ?? detectBodyFormat(event.responseBodyPreview, event.responseHeaders),
    event,
  };
}
