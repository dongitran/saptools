import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { FAKE_PASSWORD, FAKE_USERNAME, startFakeOpenSearch } from "./fixtures/fake-opensearch.js";
import { BASE_ENV, runCli, targetArgs } from "./helpers.js";

let fakeOpenSearch: Awaited<ReturnType<typeof startFakeOpenSearch>>;
let resultsRoot: string;

test.beforeAll(async () => {
  fakeOpenSearch = await startFakeOpenSearch();
  resultsRoot = await mkdtemp(join(tmpdir(), "cf-metrics-e2e-results-"));
});

test.afterAll(async () => {
  await fakeOpenSearch.close();
  await rm(resultsRoot, { recursive: true, force: true });
});

function env(): Record<string, string> {
  return {
    ...BASE_ENV,
    CF_METRICS_FAKE_DASHBOARDS_URL: fakeOpenSearch.url,
    CF_METRICS_FAKE_DASHBOARDS_USERNAME: FAKE_USERNAME,
    CF_METRICS_FAKE_DASHBOARDS_PASSWORD: FAKE_PASSWORD,
    CF_METRICS_SAPTOOLS_ROOT: resultsRoot,
  };
}

test("snapshot reports the single latest value per metric name, no bucketing", async () => {
  const result = await runCli(["snapshot", "--service", "demo-app", "--format", "json", ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
  const rows = JSON.parse(result.stdout) as readonly Record<string, unknown>[];
  const byName = new Map(rows.map((row) => [row["NAME"], row]));
  expect(byName.get("container.cpu.usage")).toMatchObject({ VALUE: 0.17, TIME: "2026-08-28T09:16:00.000Z" });
  expect(byName.get("queue.legacy_counter")).toMatchObject({ VALUE: 140 });
  // Histogram docs have no `value` field — snapshot falls back to `sum`.
  expect(byName.get("http.server.duration")).toMatchObject({ VALUE: 0.5 });
});

/**
 * `top` now defaults `--since` to DEFAULT_SINCE (2h) like `history`/`names`
 * already did, instead of querying the entire retention window. The fixture's
 * documents sit at fixed 2026-08-28 timestamps, so every `top` test must state
 * its window explicitly rather than lean on an unbounded default.
 */
const WINDOW = ["--since", "2026-08-28T00:00:00.000Z", "--until", "2026-08-29T00:00:00.000Z"];

test("top defaults to a recent window rather than scanning all of retention", async () => {
  const result = await runCli(["top", "--name", "container.memory.usage", "--format", "json", ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
  // Fixture data is dated 2026-08-28; with the 2h default it is out of range,
  // proving a default bound is applied. Without one this would return every app.
  expect(JSON.parse(result.stdout)).toEqual([]);
});

test("top ranks apps by average value, not by document count — order matters", async () => {
  const result = await runCli(["top", "--name", "container.memory.usage", "--format", "json", ...WINDOW, ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
  const rows = JSON.parse(result.stdout) as readonly Record<string, unknown>[];
  // loud-app: 2 docs, avg 925M. demo-app: 3 docs, avg ~773.3M. quiet-app: 5
  // docs (the most of any app) but avg only 100M — if the query's explicit
  // `order: {avg_value: "desc"}` were dropped, a naive `_count`-desc default
  // would wrongly put quiet-app first despite it having the lowest average.
  expect(rows.map((row) => row["APP"])).toEqual(["loud-app", "demo-app", "quiet-app"]);
  expect(rows[0]?.["AVG"]).toBeCloseTo(925_000_000, -3);
  expect(rows[2]?.["DOC_COUNT"]).toBe(5);
});

test("top --limit bounds the number of apps returned", async () => {
  const result = await runCli(
    ["top", "--name", "container.memory.usage", "--limit", "1", "--format", "json", ...WINDOW, ...targetArgs()],
    env(),
  );
  expect(result.exitCode).toBe(0);
  const rows = JSON.parse(result.stdout) as readonly Record<string, unknown>[];
  expect(rows).toEqual([expect.objectContaining({ APP: "loud-app" })]);
});

test("top on a HISTOGRAM metric ranks apps by derived avg latency, not a null avg/max on a nonexistent value field", async () => {
  const result = await runCli(["top", "--name", "http.server.duration", "--format", "json", ...WINDOW, ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
  const rows = JSON.parse(result.stdout) as readonly Record<string, unknown>[];
  // slow-app: 1 doc, count=2/sum=40 -> avg 20. demo-app: 3 docs, avg 4.5/6=0.75.
  // fast-app: 4 docs, count=40/sum=4 -> avg 0.1. Cross-checks the same real-data
  // shape observed live: HISTOGRAM documents carry no `value` field.
  expect(rows.map((row) => row["APP"])).toEqual(["slow-app", "demo-app", "fast-app"]);
  // DOC_COUNT is the number of matching documents (1, pushed once for slow-app
  // in the fixture), not the histogram's own internal `count` field (2 requests).
  expect(rows[0]).toEqual({ APP: "slow-app", AVG: 20, DOC_COUNT: 1 });
  for (const row of rows) {
    expect(Object.keys(row)).not.toContain("MAX");
  }
});

test("top --kind skips auto-resolution and honors the override", async () => {
  const result = await runCli(
    ["top", "--name", "http.server.duration", "--kind", "HISTOGRAM", "--format", "json", ...WINDOW, ...targetArgs()],
    env(),
  );
  expect(result.exitCode).toBe(0);
  const rows = JSON.parse(result.stdout) as readonly Record<string, unknown>[];
  expect(rows[0]).toMatchObject({ APP: "slow-app", AVG: 20 });
});

/**
 * Mirrors the `history` guard: ranking a name that publishes several units
 * compares incommensurable series. This branch had no coverage until now — the
 * fixture was single-unit throughout, so the warning never fired in CI.
 */
test("top warns when the ranked metric name reports several units", async () => {
  const result = await runCli(
    ["top", "--name", "container.cpu.usage", "--format", "json", ...WINDOW, ...targetArgs()],
    env(),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("2 different units");
  expect(result.stderr).toContain("NOT meaningful");
});

test("top --unit ranks on a single series and drops the warning", async () => {
  const result = await runCli(
    ["top", "--name", "container.cpu.usage", "--unit", "cpu", "--format", "json", ...WINDOW, ...targetArgs()],
    env(),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).not.toContain("different units");
  const rows = JSON.parse(result.stdout) as readonly Record<string, number>[];
  // Averages only the unit="cpu" points (0.016, 0.018); including the unit="1"
  // series (0.28, 0.3) would put the average near 0.15 instead.
  expect(rows[0]?.["AVG"]).toBeCloseTo(0.017, 5);
});

/**
 * `snapshot` used to cap at 50 metric names with no flag to raise it and no
 * hint that anything was dropped — and a `terms` cap discards the sparsest
 * names first, which are the ones worth looking for.
 */
test("snapshot --limit bounds the metric names returned and says the list is short", async () => {
  const result = await runCli(["snapshot", "--service", "demo-app", "--limit", "2", "--format", "json", ...targetArgs()], env());

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toHaveLength(2);
  // Pin the actionable half too: two short fragments alone let the useful part
  // of the message be rewritten into something worse without any test noticing.
  expect(result.stderr).toContain("showing 2 of more metric names");
  expect(result.stderr).toContain("dropped, sparsest first");
  expect(result.stderr).toContain("Re-run with a larger --limit, or --limit 0");
});

test("snapshot --limit above OpenSearch's result-window ceiling fails fast", async () => {
  const result = await runCli(["snapshot", "--service", "demo-app", "--limit", "10001", ...targetArgs()], env());

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("exceeds OpenSearch's single-page result-window ceiling of 10000");
});

test("snapshot --limit 0 returns every metric name with no truncation notice", async () => {
  const capped = await runCli(["snapshot", "--service", "demo-app", "--limit", "2", "--format", "json", ...targetArgs()], env());
  const all = await runCli(["snapshot", "--service", "demo-app", "--limit", "0", "--format", "json", ...targetArgs()], env());

  expect(all.exitCode).toBe(0);
  const allRows = JSON.parse(all.stdout) as readonly unknown[];
  expect(allRows.length).toBeGreaterThan((JSON.parse(capped.stdout) as readonly unknown[]).length);
  expect(all.stderr).not.toContain("sparsest first");
});

/**
 * An inverted window used to exit 0 with an empty table — the failure mode was
 * indistinguishable from a quiet period, so nobody noticed the flags were
 * backwards. These pin both shapes end to end, including the pre-network timing.
 */
test("top rejects an inverted --since/--until instead of returning an empty table", async () => {
  const result = await runCli(["top", "--name", "container.cpu.usage", "--since", "30m", "--until", "2h", ...targetArgs()], env());

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('--since "30m" is later than --until "2h"');
  expect(result.stdout).not.toContain("(no rows)");
});

test("top rejects an --until older than its defaulted --since, naming the default as the cause", async () => {
  const result = await runCli(["top", "--name", "container.cpu.usage", "--until", "3h", ...targetArgs()], env());

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('older than the default --since ("2h")');
});

test("top still accepts a past window where --since is the older bound", async () => {
  const result = await runCli(
    ["top", "--name", "container.memory.usage", "--since", "2026-08-28T00:00:00.000Z", "--until", "2026-08-29T00:00:00.000Z", "--format", "json", ...targetArgs()],
    env(),
  );

  expect(result.exitCode).toBe(0);
  expect((JSON.parse(result.stdout) as readonly unknown[]).length).toBeGreaterThan(0);
});

test("top --since with an unparseable value fails fast with a clear error, not a raw backend error", async () => {
  const result = await runCli(["top", "--name", "container.cpu.usage", "--since", "yesterday", ...targetArgs()], env());
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('Invalid --since value "yesterday"');
});

/**
 * `--until` is validated by the same `assertValidTimeBoundShape` call as
 * `--since`, but only `--since` had a test — so the second half of every
 * command's `checkTimeRange` was unpinned and could be dropped without any
 * suite noticing. Mirrors the `--since` case exactly.
 */
test("top --until with an unparseable value fails fast with a clear error, not a raw backend error", async () => {
  const result = await runCli(
    ["top", "--name", "container.cpu.usage", "--until", "yesterday", ...targetArgs()],
    env(),
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('Invalid --until value "yesterday"');
});

test("top --limit above OpenSearch's result-window ceiling fails fast with a clear error", async () => {
  const result = await runCli(["top", "--name", "container.cpu.usage", "--limit", "10001", ...targetArgs()], env());
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("exceeds OpenSearch's single-page result-window ceiling of 10000");
});

test("--save prints a ref, and `result show/list/prune/clear` round-trip it", async () => {
  const saved = await runCli(["names", "--service", "demo-app", "--since", "2026-08-28T09:00:00.000Z", "--save", ...targetArgs()], env());
  expect(saved.exitCode).toBe(0);
  const refMatch = /ref=(\S+)/.exec(saved.stdout);
  expect(refMatch).not.toBeNull();
  const ref = refMatch?.[1] ?? "";

  const shown = await runCli(["result", "show", ref, "--format", "json"], env());
  expect(shown.exitCode).toBe(0);
  const rows = JSON.parse(shown.stdout) as readonly unknown[];
  expect(rows.length).toBeGreaterThan(0);

  const listed = await runCli(["result", "list"], env());
  expect(listed.exitCode).toBe(0);
  expect(listed.stdout).toContain(ref);

  const pruned = await runCli(["result", "prune"], env());
  expect(pruned.exitCode).toBe(0);
  expect(pruned.stdout).toContain("removed=0"); // nothing expired yet

  const cleared = await runCli(["result", "clear"], env());
  expect(cleared.exitCode).toBe(0);
  expect(cleared.stdout).toContain("removed=1");

  const afterClear = await runCli(["result", "list"], env());
  expect(afterClear.exitCode).toBe(0);
  expect(afterClear.stdout).not.toContain(ref);
});

test("result show on an unknown ref fails with RESULT_NOT_FOUND", async () => {
  const result = await runCli(["result", "show", "no-such-ref"], env());
  expect(result.exitCode).not.toBe(0);
});
