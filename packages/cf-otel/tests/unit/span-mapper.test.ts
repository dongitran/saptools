import { describe, expect, it } from "vitest";

import { hitToSpan } from "../../src/span-mapper.js";

describe("hitToSpan", () => {
  it("maps a well-formed hit including nested status.code", () => {
    const span = hitToSpan({
      _id: "doc1",
      _source: {
        traceId: "t1",
        spanId: "s1",
        parentSpanId: "p1",
        name: "GET",
        kind: "SPAN_KIND_SERVER",
        serviceName: "service-a",
        startTime: "2026-08-28T03:00:00Z",
        durationInNanos: 1_000_000,
        status: { code: 2 },
      },
    });
    expect(span).toMatchObject({
      traceId: "t1",
      spanId: "s1",
      parentSpanId: "p1",
      name: "GET",
      kind: "SPAN_KIND_SERVER",
      serviceName: "service-a",
      startTime: "2026-08-28T03:00:00Z",
      durationInNanos: 1_000_000,
      statusCode: 2,
    });
  });

  it("treats an empty-string parentSpanId as no parent (root span)", () => {
    const span = hitToSpan({ _id: "doc1", _source: { traceId: "t1", spanId: "s1", parentSpanId: "" } });
    expect(span.parentSpanId).toBeUndefined();
  });

  it("omits parentSpanId entirely when the source has none", () => {
    const span = hitToSpan({ _id: "doc1", _source: { traceId: "t1", spanId: "s1" } });
    expect(span.parentSpanId).toBeUndefined();
  });

  it("throws when traceId or spanId is missing", () => {
    expect(() => hitToSpan({ _id: "doc1", _source: { spanId: "s1" } })).toThrow(/missing traceId\/spanId/);
    expect(() => hitToSpan({ _id: "doc1", _source: { traceId: "t1" } })).toThrow(/missing traceId\/spanId/);
  });

  it("keeps the raw source available verbatim for attribute access", () => {
    const source = { traceId: "t1", spanId: "s1", "span.attributes.http@target": "/x" };
    expect(hitToSpan({ _id: "doc1", _source: source }).raw).toBe(source);
  });
});
