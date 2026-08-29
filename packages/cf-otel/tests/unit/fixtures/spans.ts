import type { Span } from "../../../src/types.js";

/** Build a synthetic span for algorithm tests. Only `spanId` is required. */
export function makeSpan(overrides: Partial<Span> & { spanId: string }): Span {
  return {
    traceId: "trace-1",
    name: "span",
    kind: "SPAN_KIND_INTERNAL",
    serviceName: "service-a",
    startTime: "2026-01-01T00:00:00.000000000Z",
    durationInNanos: 1000,
    raw: {},
    ...overrides,
  };
}

export function isoAtOffsetMs(offsetMs: number): string {
  return new Date(Date.parse("2026-01-01T00:00:00.000Z") + offsetMs).toISOString().replace(".000Z", ".000000000Z");
}
