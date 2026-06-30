import { describe, expect, it } from "vitest";

import { compactTraceEvent, detectBodyFormat } from "../../src/trace-compact.js";
import type { StoredTraceEvent } from "../../src/trace-store.js";
import type { LiveTraceEvent } from "../../src/types.js";

describe("trace compact output", () => {
  it("detects common body formats from content type and payload shape", () => {
    expect(detectBodyFormat("{\"ok\":true}", { "content-type": "application/json" })).toBe("json");
    expect(detectBodyFormat("<root><ok>true</ok></root>", {})).toBe("xml");
    expect(detectBodyFormat("<!doctype html><html></html>", {})).toBe("html");
    expect(detectBodyFormat("a=1&b=2", { "content-type": "application/x-www-form-urlencoded" })).toBe("form");
    expect(detectBodyFormat("plain text", {})).toBe("text");
    expect(detectBodyFormat("", {})).toBe("empty");
  });

  it("omits app id and headers while keeping generated ids and compact body previews", () => {
    const record = createStoredEvent({
      requestBodyPreview: `{"message":"${"x".repeat(150)}"}`,
      responseBodyPreview: `<root>${"y".repeat(150)}</root>`,
      requestHeaders: { authorization: "Bearer raw-token" },
      responseHeaders: { "set-cookie": "session=raw-cookie" },
    });

    const compact = compactTraceEvent(record);

    expect(compact).toEqual(expect.objectContaining({
      sessionId: "s12345678",
      requestId: "r12345678",
      requestBodyFormat: "json",
      responseBodyFormat: "xml",
      requestBodyPreviewRemainingChars: record.event.requestBodyPreview.length - 128,
      responseBodyPreviewRemainingChars: record.event.responseBodyPreview.length - 128,
    }));
    expect(compact.requestBodyPreview).toHaveLength(128);
    expect(compact.responseBodyPreview).toHaveLength(128);
    expect(compact).not.toHaveProperty("appId");
    expect(compact).not.toHaveProperty("requestHeaders");
    expect(compact).not.toHaveProperty("responseHeaders");
  });

  it("does not split Unicode characters and redacts credential query values from stdout", () => {
    const record = createStoredEvent({
      url: "/orders?access_token=raw-token&view=full",
      normalizedUrl: "/orders?access_token=raw-token&view=full",
      responseBodyPreview: "😀".repeat(130),
    });

    const compact = compactTraceEvent(record);

    expect(compact.url).toBe("/orders?access_token=redacted&view=full");
    expect(compact.normalizedUrl).toBe("/orders?access_token=redacted&view=full");
    expect(Array.from(compact.responseBodyPreview)).toHaveLength(128);
    expect(compact.responseBodyPreviewRemainingChars).toBe(2);
    expect(record.event.url).toContain("raw-token");
  });
});

function createStoredEvent(overrides: Partial<LiveTraceEvent> = {}): StoredTraceEvent {
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
    requestBytes: 256,
    responseBytes: 512,
    requestHeaders: {},
    responseHeaders: {},
    requestBodyPreview: "",
    responseBodyPreview: "",
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
    requestBodyFormat: detectBodyFormat(event.requestBodyPreview, event.requestHeaders),
    responseBodyFormat: detectBodyFormat(event.responseBodyPreview, event.responseHeaders),
    event,
  };
}
