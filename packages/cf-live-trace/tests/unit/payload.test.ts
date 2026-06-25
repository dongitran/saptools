import { describe, expect, it } from "vitest";

import { parseDrainResult } from "../../src/payload.js";

describe("payload parsing", () => {
  it("parses raw runtime events without redacting captured values", () => {
    const parsed = parseDrainResult(
      {
        events: [
          {
            id: "trace-1",
            timestamp: "2026-06-18T07:22:10.120Z",
            instance: "0",
            method: "post",
            path: "/odata/v4/orders",
            url: "https://app.example.com/odata/v4/orders?access_token=raw-token",
            normalizedUrl: "/odata/v4/orders?access_token=raw-token",
            status: 201,
            durationMs: 42,
            requestBytes: 12,
            responseBytes: 24,
            requestHeaders: { authorization: "Bearer raw-token" },
            responseHeaders: { "set-cookie": "session=raw-cookie" },
            requestBodyPreview: "{\"client_secret\":\"raw-secret\"}",
            responseBodyPreview: "{\"token\":\"raw-response-token\"}",
            requestBodyTruncated: false,
            responseBodyTruncated: false,
            droppedBeforeEvent: 0,
            traceId: "trace-1",
            correlationId: "corr-1",
          },
        ],
        droppedCount: 0,
        queueSize: 0,
      },
      { appId: "finance-uat-api", maxBodyBytes: 4096 },
    );

    expect(parsed.events[0]).toEqual(
      expect.objectContaining({
        appId: "finance-uat-api",
        method: "POST",
        requestHeaders: { authorization: "Bearer raw-token" },
        responseHeaders: { "set-cookie": "session=raw-cookie" },
        requestBodyPreview: "{\"client_secret\":\"raw-secret\"}",
        responseBodyPreview: "{\"token\":\"raw-response-token\"}",
      }),
    );
  });

  it("ignores malformed events and truncates long body previews", () => {
    const parsed = parseDrainResult(
      {
        events: [
          null,
          {
            method: "GET",
            url: "/health",
            requestBodyPreview: "abcdef",
            responseBodyPreview: "123456",
          },
        ],
        droppedCount: 2,
        queueSize: 9,
      },
      { appId: "finance-uat-api", maxBodyBytes: 3 },
    );

    expect(parsed.droppedCount).toBe(2);
    expect(parsed.queueSize).toBe(9);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toEqual(
      expect.objectContaining({
        requestBodyPreview: "abc",
        requestBodyTruncated: true,
        responseBodyPreview: "123",
        responseBodyTruncated: true,
      }),
    );
  });
});
