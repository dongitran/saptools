import { describe, expect, it } from "vitest";

import { computeDiff, sortDiffRows } from "../../src/diff.js";
import type { DiffRow } from "../../src/types.js";

import { makeSpan } from "./fixtures/spans.js";

describe("computeDiff", () => {
  it("shows a name present only in trace A as zero on side B, not dropped", () => {
    const spansA = [makeSpan({ spanId: "a1", name: "OnlyInA", durationInNanos: 500 })];
    const spansB = [makeSpan({ spanId: "b1", name: "InBoth", durationInNanos: 100 })];

    const result = computeDiff(spansA, spansB);
    const row = result.rows.find((candidate) => candidate.name === "OnlyInA");

    expect(row).toBeDefined();
    expect(row).toMatchObject({ selfANanos: 500, selfBNanos: 0, countA: 1, countB: 0 });
  });

  it("shows a name present only in trace B as zero on side A, not dropped", () => {
    const spansA = [makeSpan({ spanId: "a1", name: "InBoth", durationInNanos: 100 })];
    const spansB = [makeSpan({ spanId: "b1", name: "OnlyInB", durationInNanos: 300 })];

    const result = computeDiff(spansA, spansB);
    const row = result.rows.find((candidate) => candidate.name === "OnlyInB");

    expect(row).toBeDefined();
    expect(row).toMatchObject({ selfANanos: 0, selfBNanos: 300, countA: 0, countB: 1 });
  });

  it("joins a name present on both sides with real values from each", () => {
    const spansA = [makeSpan({ spanId: "a1", name: "HEAD", durationInNanos: 200 })];
    const spansB = [
      makeSpan({ spanId: "b1", name: "HEAD", durationInNanos: 50 }),
      makeSpan({ spanId: "b2", name: "HEAD", durationInNanos: 50 }),
    ];

    const result = computeDiff(spansA, spansB);
    const row = result.rows.find((candidate) => candidate.name === "HEAD");

    expect(row).toMatchObject({ selfANanos: 200, selfBNanos: 100, countA: 1, countB: 2 });
  });

  it("carries each trace's own root duration through independently", () => {
    const spansA = [makeSpan({ spanId: "rootA", name: "root", durationInNanos: 1000 })];
    const spansB = [makeSpan({ spanId: "rootB", name: "root", durationInNanos: 700 })];

    const result = computeDiff(spansA, spansB);

    expect(result.rootANanos).toBe(1000);
    expect(result.rootBNanos).toBe(700);
  });

  it("never drops a row even when the two traces' name sets are entirely disjoint", () => {
    const spansA = [makeSpan({ spanId: "a1", name: "Alpha", durationInNanos: 1 })];
    const spansB = [makeSpan({ spanId: "b1", name: "Beta", durationInNanos: 1 })];

    const result = computeDiff(spansA, spansB);

    expect(result.rows.map((row) => row.name).sort()).toEqual(["Alpha", "Beta"]);
  });
});

describe("sortDiffRows", () => {
  // Deliberately constructed so delta/pct/selfA/selfB each produce a
  // DIFFERENT ordering — a swapped comparator, a wrong field, or a missing
  // abs() on delta/pct would each fail a different one of the assertions
  // below (the previous version of this suite never actually invoked the
  // sort comparator at all: every fixture had <=1 row, and Array.sort skips
  // the comparator entirely for 0/1-element arrays).
  const ROWS: readonly DiffRow[] = [
    { name: "R-A", selfANanos: 1000, selfBNanos: 200, countA: 5, countB: 1 }, // delta=-800, pct=80%
    { name: "R-B", selfANanos: 100, selfBNanos: 1200, countA: 2, countB: 9 }, // delta=+1100, pct=1100%
    { name: "R-C", selfANanos: 900, selfBNanos: 900, countA: 3, countB: 3 }, // delta=0, pct=0%
    { name: "R-D", selfANanos: 10, selfBNanos: 50, countA: 1, countB: 4 }, // delta=+40, pct=400%
  ];

  it("sorts by absolute delta descending (the default)", () => {
    expect(sortDiffRows(ROWS, "delta").map((row) => row.name)).toEqual(["R-B", "R-A", "R-D", "R-C"]);
  });

  it("sorts by absolute percent change descending, independently of raw delta order", () => {
    expect(sortDiffRows(ROWS, "pct").map((row) => row.name)).toEqual(["R-B", "R-D", "R-A", "R-C"]);
  });

  it("sorts by self-time A descending", () => {
    expect(sortDiffRows(ROWS, "selfA").map((row) => row.name)).toEqual(["R-A", "R-C", "R-B", "R-D"]);
  });

  it("sorts by self-time B descending, independently of the selfA order", () => {
    // selfB values: R-A=200, R-B=1200, R-C=900, R-D=50.
    expect(sortDiffRows(ROWS, "selfB").map((row) => row.name)).toEqual(["R-B", "R-C", "R-A", "R-D"]);
  });

  it("does not mutate the input array", () => {
    const copy = [...ROWS];
    sortDiffRows(ROWS, "delta");
    expect(ROWS).toEqual(copy);
  });

  it("treats a zero self-time-A baseline as an infinite percent change, sorting it first", () => {
    const withZero: readonly DiffRow[] = [
      { name: "has-baseline", selfANanos: 1000, selfBNanos: 1100, countA: 1, countB: 1 },
      { name: "new-in-b", selfANanos: 0, selfBNanos: 5, countA: 0, countB: 1 },
    ];
    expect(sortDiffRows(withZero, "pct").map((row) => row.name)).toEqual(["new-in-b", "has-baseline"]);
  });

  it("does NOT treat a true 0-vs-0 no-op row as an infinite percent change", () => {
    // Regression test: a zero baseline with an ALSO-zero delta (nothing
    // actually changed) must not outrank a row with a real, large, finite
    // swing just because dividing by a zero baseline naively looks infinite.
    const rows: readonly DiffRow[] = [
      { name: "real-change", selfANanos: 1000, selfBNanos: 1100, countA: 1, countB: 1 }, // +10%
      { name: "zero-vs-zero", selfANanos: 0, selfBNanos: 0, countA: 0, countB: 0 }, // no change at all
      { name: "genuinely-new", selfANanos: 0, selfBNanos: 5, countA: 0, countB: 1 }, // truly infinite
    ];
    expect(sortDiffRows(rows, "pct").map((row) => row.name)).toEqual(["genuinely-new", "real-change", "zero-vs-zero"]);
  });
});
