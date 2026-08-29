import { describe, expect, it } from "vitest";

import { computeSelftime } from "../../src/selftime.js";

import { makeSpan } from "./fixtures/spans.js";

describe("computeSelftime", () => {
  it("computes correct self-time across a 3-level tree and aggregates by name", () => {
    // root(A, 1000) -> child1(B, 400) -> grandchild(C, 150)
    //              -> child2(B, 300)
    const spans = [
      makeSpan({ spanId: "root", name: "A", durationInNanos: 1000 }),
      makeSpan({ spanId: "child1", parentSpanId: "root", name: "B", durationInNanos: 400 }),
      makeSpan({ spanId: "grandchild", parentSpanId: "child1", name: "C", durationInNanos: 150 }),
      makeSpan({ spanId: "child2", parentSpanId: "root", name: "B", durationInNanos: 300 }),
    ];

    const result = computeSelftime(spans);

    expect(result.clampedCount).toBe(0);
    expect(result.rootDurationNanos).toBe(1000);
    expect(result.totalSpanCount).toBe(4);

    const byName = new Map(result.byName.map((row) => [row.key, row]));
    // A: self = 1000 - (400+300) = 300
    expect(byName.get("A")).toMatchObject({ count: 1, selfTotalNanos: 300, inclusiveTotalNanos: 1000 });
    // B: child1 self = 400-150=250, child2 self = 300-0=300, total = 550
    expect(byName.get("B")).toMatchObject({ count: 2, selfTotalNanos: 550, inclusiveTotalNanos: 700 });
    // C: self = 150-0=150
    expect(byName.get("C")).toMatchObject({ count: 1, selfTotalNanos: 150, inclusiveTotalNanos: 150 });

    // % of root uses the single root's duration (1000)
    expect(byName.get("A")?.pctOfRoot).toBeCloseTo(30, 5);
    expect(byName.get("B")?.pctOfRoot).toBeCloseTo(55, 5);
    expect(byName.get("C")?.pctOfRoot).toBeCloseTo(15, 5);

    // Ranked descending by self-time: B (550) > A (300) > C (150)
    expect(result.byName.map((row) => row.key)).toEqual(["B", "A", "C"]);
  });

  it("clamps to zero and counts it when children's summed duration exceeds the parent's own duration", () => {
    const spans = [
      makeSpan({ spanId: "root", name: "root", durationInNanos: 1000 }),
      makeSpan({ spanId: "clamped-parent", parentSpanId: "root", name: "clamped", durationInNanos: 100 }),
      makeSpan({ spanId: "child-a", parentSpanId: "clamped-parent", name: "child-a", durationInNanos: 80 }),
      makeSpan({ spanId: "child-b", parentSpanId: "clamped-parent", name: "child-b", durationInNanos: 60 }),
    ];

    const result = computeSelftime(spans);

    expect(result.clampedCount).toBe(1);
    const clamped = result.byName.find((row) => row.key === "clamped");
    expect(clamped?.selfTotalNanos).toBe(0);
  });

  it("computes correct non-negative self-time for multiple children overlapping in time", () => {
    // Overlap doesn't change the self-time formula (it only sums durations, not wall-clock
    // occupancy), but the result must still be correct and non-negative regardless.
    const spans = [
      makeSpan({ spanId: "root", name: "root", durationInNanos: 500 }),
      makeSpan({
        spanId: "overlap-a",
        parentSpanId: "root",
        name: "overlap-a",
        startTime: "2026-01-01T00:00:00.000000000Z",
        durationInNanos: 200,
      }),
      makeSpan({
        spanId: "overlap-b",
        parentSpanId: "root",
        name: "overlap-b",
        startTime: "2026-01-01T00:00:00.100000000Z",
        durationInNanos: 200,
      }),
    ];

    const result = computeSelftime(spans);

    expect(result.clampedCount).toBe(0);
    const rootRow = result.byName.find((row) => row.key === "root");
    expect(rootRow?.selfTotalNanos).toBe(100); // 500 - (200+200)
    expect(rootRow?.selfTotalNanos).toBeGreaterThanOrEqual(0);
  });

  it("reports rootDurationNanos as undefined when there are zero or multiple root spans", () => {
    const noRoots = computeSelftime([makeSpan({ spanId: "a", parentSpanId: "missing-parent" })]);
    expect(noRoots.rootDurationNanos).toBeUndefined();
    expect(noRoots.rootSpans).toHaveLength(0);

    const twoRoots = computeSelftime([
      makeSpan({ spanId: "root1", durationInNanos: 100 }),
      makeSpan({ spanId: "root2", durationInNanos: 200 }),
    ]);
    expect(twoRoots.rootDurationNanos).toBeUndefined();
    expect(twoRoots.rootSpans).toHaveLength(2);
    // pctOfRoot must be undefined rather than a misleading number when root duration is unknown.
    expect(twoRoots.byName.every((row) => row.pctOfRoot === undefined)).toBe(true);
  });

  it("produces a parallel, independent breakdown by serviceName", () => {
    const spans = [
      makeSpan({ spanId: "root", serviceName: "svc-a", durationInNanos: 100 }),
      makeSpan({ spanId: "child", parentSpanId: "root", serviceName: "svc-b", durationInNanos: 40 }),
    ];
    const result = computeSelftime(spans);
    const byService = new Map(result.byService.map((row) => [row.key, row]));
    expect(byService.get("svc-a")?.selfTotalNanos).toBe(60);
    expect(byService.get("svc-b")?.selfTotalNanos).toBe(40);
  });
});
