import { computeSelftime } from "./selftime.js";
import type { DiffResult, DiffRow, DiffSort, Span } from "./types.js";

/**
 * Join two traces' self-time-by-name breakdowns. A name present on only one
 * side is shown with a zero on the other side rather than dropped — a naive
 * inner join would silently lose exactly the rows most worth seeing in a
 * before/after comparison (something that disappeared, or something new).
 * Rows come back sorted by name; callers apply whichever `--sort` the user
 * asked for (delta/pct/selfA/selfB) at display time.
 */
export function computeDiff(spansA: readonly Span[], spansB: readonly Span[]): DiffResult {
  const resultA = computeSelftime(spansA);
  const resultB = computeSelftime(spansB);
  const byNameA = new Map(resultA.byName.map((row) => [row.key, row]));
  const byNameB = new Map(resultB.byName.map((row) => [row.key, row]));
  const allNames = new Set<string>([...byNameA.keys(), ...byNameB.keys()]);

  const rows: DiffRow[] = [...allNames].sort().map((name) => {
    const a = byNameA.get(name);
    const b = byNameB.get(name);
    return {
      name,
      selfANanos: a?.selfTotalNanos ?? 0,
      selfBNanos: b?.selfTotalNanos ?? 0,
      countA: a?.count ?? 0,
      countB: b?.count ?? 0,
    };
  });

  return { rootANanos: resultA.rootDurationNanos, rootBNanos: resultB.rootDurationNanos, rows };
}

function pctChangeMagnitude(selfANanos: number, delta: number): number {
  if (selfANanos !== 0) {
    return Math.abs(delta) / selfANanos;
  }
  // A zero baseline with a genuine change (new in B) is an infinite percent
  // change and sorts first; a zero baseline with NO change (0 -> 0, delta
  // also 0 — nothing actually happened) must not also read as infinite, or
  // it would wrongly outrank every row with a real, large, finite swing.
  return delta === 0 ? 0 : Number.POSITIVE_INFINITY;
}

/**
 * Sort diff rows by the requested dimension. `delta`/`pct` compare absolute
 * magnitude, descending, so the biggest swings surface first regardless of
 * which direction they moved (per spec); `pct` treats a zero `selfANanos`
 * baseline as an infinite percent change only when there's an actual
 * nonzero delta (i.e. genuinely new in B), not for a true 0-vs-0 no-op row.
 */
export function sortDiffRows(rows: readonly DiffRow[], sortBy: DiffSort): readonly DiffRow[] {
  const withDelta = rows.map((row) => ({ row, delta: row.selfBNanos - row.selfANanos }));
  withDelta.sort((left, right) => {
    switch (sortBy) {
      case "delta":
        return Math.abs(right.delta) - Math.abs(left.delta);
      case "pct": {
        const pctLeft = pctChangeMagnitude(left.row.selfANanos, left.delta);
        const pctRight = pctChangeMagnitude(right.row.selfANanos, right.delta);
        return pctRight - pctLeft;
      }
      case "selfA":
        return right.row.selfANanos - left.row.selfANanos;
      case "selfB":
        return right.row.selfBNanos - left.row.selfBNanos;
    }
  });
  return withDelta.map((entry) => entry.row);
}
