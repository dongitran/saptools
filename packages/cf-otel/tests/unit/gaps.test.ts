import { describe, expect, it } from "vitest";

import { computeGaps } from "../../src/gaps.js";

import { isoAtOffsetMs, makeSpan } from "./fixtures/spans.js";

describe("computeGaps — stats", () => {
  it("matches hand-computed sum/min/max/mean/median/stdev for a known gap sequence", () => {
    // Parent [0, 1000)ms; children at 100-150, 250-300, 500-550 => gaps (ms) [100,100,200] + trailing 450.
    const parent = makeSpan({ spanId: "parent", startTime: isoAtOffsetMs(0), durationInNanos: 1_000 * 1_000_000 });
    const children = [
      makeSpan({ spanId: "c1", parentSpanId: "parent", name: "c1", startTime: isoAtOffsetMs(100), durationInNanos: 50 * 1_000_000 }),
      makeSpan({ spanId: "c2", parentSpanId: "parent", name: "c2", startTime: isoAtOffsetMs(250), durationInNanos: 50 * 1_000_000 }),
      makeSpan({ spanId: "c3", parentSpanId: "parent", name: "c3", startTime: isoAtOffsetMs(500), durationInNanos: 50 * 1_000_000 }),
    ];

    const result = computeGaps(parent, children);

    const gapsMs = [100, 100, 200, 450];
    const gapsNanos = gapsMs.map((ms) => ms * 1_000_000);
    expect(result.gaps.map((gap) => gap.gapNanos)).toEqual(gapsNanos);

    const expectedSum = gapsNanos.reduce((a, b) => a + b, 0);
    const expectedMean = expectedSum / gapsNanos.length;
    const expectedVariance = gapsNanos.reduce((acc, v) => acc + (v - expectedMean) ** 2, 0) / gapsNanos.length;

    expect(result.stats.count).toBe(4);
    expect(result.stats.sumNanos).toBe(expectedSum);
    expect(result.stats.minNanos).toBe(100 * 1_000_000);
    expect(result.stats.maxNanos).toBe(450 * 1_000_000);
    expect(result.stats.meanNanos).toBeCloseTo(expectedMean, 5);
    expect(result.stats.medianNanos).toBe(150 * 1_000_000); // average of the middle two: (100+200)/2
    expect(result.stats.stdevNanos).toBeCloseTo(Math.sqrt(expectedVariance), 5);

    expect(result.totalPairCount).toBe(2);
    expect(result.overlappingPairCount).toBe(0);
  });

  it("reports a flat verdict when the regression slope predicts almost no change", () => {
    // 5 children, every gap (including the trailing one) is exactly 50ms.
    const parent = makeSpan({ spanId: "parent", startTime: isoAtOffsetMs(0), durationInNanos: 800 * 1_000_000 });
    const children = [50, 200, 350, 500, 650].map((startMs, index) =>
      makeSpan({
        spanId: `c${String(index)}`,
        parentSpanId: "parent",
        name: `c${String(index)}`,
        startTime: isoAtOffsetMs(startMs),
        durationInNanos: 100 * 1_000_000,
      }),
    );

    const result = computeGaps(parent, children);

    expect(result.gaps.map((gap) => gap.gapNanos)).toEqual([50, 50, 50, 50, 50, 50].map((ms) => ms * 1_000_000));
    expect(result.regression).toBeDefined();
    expect(result.regression?.verdict).toBe("flat");
    expect(result.regression?.slopeNanosPerOccurrence).toBeCloseTo(0, 5);
  });

  it("reports a growing verdict when gaps clearly increase with occurrence index", () => {
    // A clean arithmetic progression: gaps (ms) = [50, 90, 130, 170, 210, 250], slope=40ms/occurrence.
    const starts = [50, 160, 310, 500, 730];
    const parent = makeSpan({ spanId: "parent", startTime: isoAtOffsetMs(0), durationInNanos: 1_000 * 1_000_000 });
    const children = starts.map((startMs, index) =>
      makeSpan({
        spanId: `c${String(index)}`,
        parentSpanId: "parent",
        name: `c${String(index)}`,
        startTime: isoAtOffsetMs(startMs),
        durationInNanos: 20 * 1_000_000,
      }),
    );

    const result = computeGaps(parent, children);

    expect(result.gaps.map((gap) => gap.gapNanos)).toEqual([50, 90, 130, 170, 210, 250].map((ms) => ms * 1_000_000));
    expect(result.regression?.verdict).toBe("growing");
    expect(result.regression?.slopeNanosPerOccurrence).toBeCloseTo(40 * 1_000_000, -3);
  });

  it("restricts the regression to gaps preceding a --filter-next-matching child name", () => {
    const parent = makeSpan({ spanId: "parent", startTime: isoAtOffsetMs(0), durationInNanos: 1_000 * 1_000_000 });
    const children = [
      makeSpan({ spanId: "c1", parentSpanId: "parent", name: "setup", startTime: isoAtOffsetMs(10), durationInNanos: 1_000_000 }),
      makeSpan({ spanId: "c2", parentSpanId: "parent", name: "UPDATE Config", startTime: isoAtOffsetMs(100), durationInNanos: 1_000_000 }),
      makeSpan({ spanId: "c3", parentSpanId: "parent", name: "UPDATE Config", startTime: isoAtOffsetMs(300), durationInNanos: 1_000_000 }),
    ];

    const result = computeGaps(parent, children, { filterNextPattern: "*UPDATE Config" });

    // Only gaps whose *next* span matches are used, so intercept/slope must not be
    // computed against the setup gap at all.
    expect(result.regression?.sampleCount).toBe(2);
  });

  it("counts exactly the pairs that actually overlap in time, and lets an overlapping pair's gap go negative", () => {
    // Per the spec's own reference-session output, real gap sequences can have
    // a negative min (e.g. "min=-0.076s") — overlap must NOT be clamped away.
    const parent = makeSpan({ spanId: "parent", startTime: isoAtOffsetMs(0), durationInNanos: 500 * 1_000_000 });
    const children = [
      makeSpan({ spanId: "c1", parentSpanId: "parent", name: "c1", startTime: isoAtOffsetMs(0), durationInNanos: 200 * 1_000_000 }),
      // starts at 100 < c1's end (200) => overlaps c1
      makeSpan({ spanId: "c2", parentSpanId: "parent", name: "c2", startTime: isoAtOffsetMs(100), durationInNanos: 100 * 1_000_000 }),
      // starts at 250 >= c2's end (200) => does not overlap c2
      makeSpan({ spanId: "c3", parentSpanId: "parent", name: "c3", startTime: isoAtOffsetMs(250), durationInNanos: 50 * 1_000_000 }),
    ];

    const result = computeGaps(parent, children);

    expect(result.totalPairCount).toBe(2);
    expect(result.overlappingPairCount).toBe(1);
    // c2 overlaps c1 by 100ms, so its gap is exactly -100ms, not clamped to 0.
    expect(result.gaps.map((gap) => gap.gapNanos)).toEqual([0, -100, 50, 200].map((ms) => ms * 1_000_000));
  });

  it("happens to match selfTimeNanos when an overlapping child's end exactly ties the established frontier", () => {
    // NOT a general guarantee — see the next test for a fixture where the
    // two legitimately diverge. Here c2 ends at exactly 200, the same point
    // c1 already extended the frontier to, which is what makes c2's gap
    // (-100) equal exactly -(c2's own duration) in this specific fixture.
    const parent = makeSpan({ spanId: "parent", startTime: isoAtOffsetMs(0), durationInNanos: 500 * 1_000_000 });
    const children = [
      makeSpan({ spanId: "c1", parentSpanId: "parent", name: "c1", startTime: isoAtOffsetMs(0), durationInNanos: 200 * 1_000_000 }),
      makeSpan({ spanId: "c2", parentSpanId: "parent", name: "c2", startTime: isoAtOffsetMs(100), durationInNanos: 100 * 1_000_000 }),
      makeSpan({ spanId: "c3", parentSpanId: "parent", name: "c3", startTime: isoAtOffsetMs(250), durationInNanos: 50 * 1_000_000 }),
    ];

    const result = computeGaps(parent, children);

    const expectedSelfTimeNanos = 150 * 1_000_000;
    expect(result.stats.sumNanos).toBe(expectedSelfTimeNanos);
    expect(result.selfTimeNanos).toBe(expectedSelfTimeNanos);
  });

  it("lets the raw gap sum legitimately diverge from selfTimeNanos when a nested child ends well before the frontier", () => {
    // Regression test for a real mistake caught during review: a child
    // nested WITH SLACK inside coverage an earlier sibling already
    // established (c2 ends at 30, well before c1's own end at 80) produces
    // a gap reflecting how far *before the frontier* it started (-70ms),
    // not its own 20ms duration. The raw sum (-50ms) is correct as computed
    // but does NOT equal selfTimeNanos (0ms, since 80+20 consumes the full
    // 100ms parent) — the two are an approximate cross-check, not an
    // identity, exactly as documented on computeGaps.
    const parent = makeSpan({ spanId: "parent", startTime: isoAtOffsetMs(0), durationInNanos: 100 * 1_000_000 });
    const children = [
      makeSpan({ spanId: "c1", parentSpanId: "parent", name: "c1", startTime: isoAtOffsetMs(0), durationInNanos: 80 * 1_000_000 }),
      makeSpan({ spanId: "c2", parentSpanId: "parent", name: "c2", startTime: isoAtOffsetMs(10), durationInNanos: 20 * 1_000_000 }),
    ];

    const result = computeGaps(parent, children);

    expect(result.gaps.map((gap) => gap.gapNanos)).toEqual([0, -70, 20].map((ms) => ms * 1_000_000));
    expect(result.stats.sumNanos).toBe(-50 * 1_000_000);
    expect(result.selfTimeNanos).toBe(0);
    expect(result.stats.sumNanos).not.toBe(result.selfTimeNanos);
  });

  it("clamps selfTimeNanos to zero when children's summed duration exceeds the parent's own duration", () => {
    // Independent of gap signs entirely: this only exercises the
    // selfTimeNanos sanity-check field's own clamping, mirroring selftime.ts's
    // per-span clamping behavior for a parent/children pair with clock skew.
    const parent = makeSpan({ spanId: "parent", startTime: isoAtOffsetMs(0), durationInNanos: 100 * 1_000_000 });
    const children = [
      makeSpan({ spanId: "c1", parentSpanId: "parent", name: "c1", startTime: isoAtOffsetMs(0), durationInNanos: 80 * 1_000_000 }),
      makeSpan({ spanId: "c2", parentSpanId: "parent", name: "c2", startTime: isoAtOffsetMs(10), durationInNanos: 80 * 1_000_000 }),
    ];

    const result = computeGaps(parent, children);

    expect(result.selfTimeNanos).toBe(0);
  });

  it("only includes non-empty histogram buckets", () => {
    // One child at +10ms (duration 1ms) inside an 711ms parent produces exactly two gaps:
    // a 10ms leading gap ("<50ms") and a 700ms trailing gap ("600ms-1s"). Every bucket in
    // between (50-100ms, 100-300ms, 300-600ms) must be entirely absent, not present as zero.
    const parent = makeSpan({ spanId: "parent", startTime: isoAtOffsetMs(0), durationInNanos: 711 * 1_000_000 });
    const children = [makeSpan({ spanId: "c1", parentSpanId: "parent", startTime: isoAtOffsetMs(10), durationInNanos: 1 * 1_000_000 })];

    const result = computeGaps(parent, children);

    expect(result.gaps.map((gap) => gap.gapNanos)).toEqual([10 * 1_000_000, 700 * 1_000_000]);
    expect(result.histogram).toEqual({ "<50ms": 1, "600ms-1s": 1 });
    expect(Object.keys(result.histogram)).not.toContain("100ms-300ms");
    expect(Object.keys(result.histogram)).not.toContain("300ms-600ms");
  });
});
