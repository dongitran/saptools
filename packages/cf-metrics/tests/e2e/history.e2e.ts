import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { FAKE_PASSWORD, FAKE_USERNAME, startFakeOpenSearch } from "./fixtures/fake-opensearch.js";
import { BASE_ENV, runCli, targetArgs } from "./helpers.js";

let fakeOpenSearch: Awaited<ReturnType<typeof startFakeOpenSearch>>;
// `--save` writes to ~/.saptools/cf-metrics/results by default; point it at a
// throwaway directory so the suite never touches the developer's real store.
let resultsRoot: string;

test.beforeAll(async () => {
  fakeOpenSearch = await startFakeOpenSearch();
  resultsRoot = await mkdtemp(join(tmpdir(), "cf-metrics-e2e-history-"));
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

const WINDOW = ["--since", "2026-08-28T09:00:00.000Z", "--until", "2026-08-28T09:20:00.000Z"];

test("history on a GAUGE metric reports avg/min/max per bucket, kind auto-resolved", async () => {
  const result = await runCli(
    ["history", "--service", "demo-app", "--name", "container.cpu.usage", "--interval", "10m", "--format", "json", ...WINDOW, ...targetArgs()],
    env(),
  );
  expect(result.exitCode).toBe(0);
  const rows = JSON.parse(result.stdout) as readonly Record<string, unknown>[];
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ TIME: "2026-08-28T09:00:00.000Z", DOC_COUNT: 2 });
  expect(rows[0]?.["AVG"]).toBeCloseTo(0.055, 5);
  expect(rows[0]?.["MIN"]).toBeCloseTo(0.05, 5);
  expect(rows[0]?.["MAX"]).toBeCloseTo(0.06, 5);
  expect(rows[1]).toMatchObject({ TIME: "2026-08-28T09:10:00.000Z", DOC_COUNT: 2 });
  expect(rows[1]?.["AVG"]).toBeCloseTo(0.16, 5);
});

test("--kind skips auto-resolution and produces the same GAUGE-shaped output", async () => {
  const result = await runCli(
    ["history", "--service", "demo-app", "--name", "container.cpu.usage", "--interval", "10m", "--kind", "GAUGE", "--format", "json", ...WINDOW, ...targetArgs()],
    env(),
  );
  expect(result.exitCode).toBe(0);
  const rows = JSON.parse(result.stdout) as readonly Record<string, unknown>[];
  expect(rows).toHaveLength(2);
  expect(rows[0]?.["AVG"]).toBeCloseTo(0.055, 5);
});

test("history on a SUM metric (delta temporality) sums per bucket, no warning", async () => {
  const result = await runCli(
    ["history", "--service", "demo-app", "--name", "queue.incoming_messages", "--interval", "10m", "--format", "json", ...WINDOW, ...targetArgs()],
    env(),
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr).not.toContain("CUMULATIVE");
  const rows = JSON.parse(result.stdout) as readonly Record<string, unknown>[];
  expect(rows).toEqual([
    { TIME: "2026-08-28T09:00:00.000Z", SUM: 8, DOC_COUNT: 2 },
    { TIME: "2026-08-28T09:10:00.000Z", SUM: 10, DOC_COUNT: 1 },
  ]);
});

test("history on a SUM metric reporting cumulative temporality prints a warning instead of guessing", async () => {
  const result = await runCli(
    ["history", "--service", "demo-app", "--name", "queue.legacy_counter", "--interval", "10m", ...WINDOW, ...targetArgs()],
    env(),
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("AGGREGATION_TEMPORALITY_CUMULATIVE");
  expect(result.stderr).toContain("not delta-corrected");
});

test("history on a HISTOGRAM metric reports count/sum/derived-avg per bucket, no percentiles", async () => {
  const result = await runCli(
    ["history", "--service", "demo-app", "--name", "http.server.duration", "--interval", "10m", "--format", "json", ...WINDOW, ...targetArgs()],
    env(),
  );
  expect(result.exitCode).toBe(0);
  const rows = JSON.parse(result.stdout) as readonly Record<string, unknown>[];
  expect(rows).toEqual([
    { TIME: "2026-08-28T09:00:00.000Z", COUNT: 5, SUM: 4, AVG: 0.8, DOC_COUNT: 2 },
    { TIME: "2026-08-28T09:10:00.000Z", COUNT: 1, SUM: 0.5, AVG: 0.5, DOC_COUNT: 1 },
  ]);
  for (const row of rows) {
    expect(Object.keys(row)).not.toContain("P50");
    expect(Object.keys(row)).not.toContain("P95");
  }
});

test("history requires at least one --name", async () => {
  const result = await runCli(["history", "--service", "demo-app", ...WINDOW, ...targetArgs()], env());
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("At least one --name is required");
});

test("history --interval with an unparseable value fails fast with a clear error, not a raw backend error", async () => {
  const result = await runCli(
    ["history", "--service", "demo-app", "--name", "container.cpu.usage", "--interval", "bogus", ...WINDOW, ...targetArgs()],
    env(),
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('Invalid --interval value "bogus"');
  // Failed before any query — the resolved-target notice never printed.
  expect(result.stderr).not.toContain("target");
});

test("history --interval 0m fails fast as a zero-magnitude duration, not a backend round trip", async () => {
  const result = await runCli(
    ["history", "--service", "demo-app", "--name", "container.cpu.usage", "--interval", "0m", ...WINDOW, ...targetArgs()],
    env(),
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('Invalid --interval value "0m"');
  // Failed before any query — the resolved-target notice never printed.
  expect(result.stderr).not.toContain("target");
});

test("history --since with an unparseable value fails fast with a clear error, not a raw backend error", async () => {
  const result = await runCli(
    ["history", "--service", "demo-app", "--name", "container.cpu.usage", "--since", "not-a-time", ...targetArgs()],
    env(),
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('Invalid --since value "not-a-time"');
});

test("history charts multiple --name flags in one call, each labeled", async () => {
  const result = await runCli(
    ["history", "--service", "demo-app", "--name", "container.cpu.usage", "--name", "container.memory.usage", "--interval", "10m", ...WINDOW, ...targetArgs()],
    env(),
  );
  expect(result.exitCode).toBe(0);
  // Per-metric headers go to stderr (printNotice), same stream as the
  // resolved-target notice — the numeric rows themselves land on stdout.
  expect(result.stderr).toContain("container.cpu.usage (GAUGE)");
  expect(result.stderr).toContain("container.memory.usage (GAUGE)");
  expect(result.stdout).toContain("0.055");
  expect(result.stdout).toContain("410000000");
  // Combined rows stay attributable via a NAME column.
  expect(result.stdout).toContain("NAME");
});

/**
 * Regression guard: rows used to be emitted once per `--name` inside the loop,
 * so two names produced two concatenated JSON arrays — unparseable — while the
 * command still exited 0. A pipeline got no signal that anything was wrong.
 */
test("history with several --name flags emits ONE valid JSON document, not concatenated arrays", async () => {
  const result = await runCli(
    [
      "history",
      "--service",
      "demo-app",
      "--name",
      "container.cpu.usage",
      "--name",
      "container.memory.usage",
      "--interval",
      "10m",
      "--format",
      "json",
      ...WINDOW,
      ...targetArgs(),
    ],
    env(),
  );

  expect(result.exitCode).toBe(0);
  expect(() => {
    JSON.parse(result.stdout);
  }).not.toThrow();
  const rows = JSON.parse(result.stdout) as readonly Record<string, unknown>[];
  expect(new Set(rows.map((row) => row["NAME"]))).toEqual(
    new Set(["container.cpu.usage", "container.memory.usage"]),
  );
});

/**
 * `--save` on `history` had no coverage at all, and the emit-once change moved
 * it from one saved result per `--name` to a single combined one. Pinning that
 * here, since a silently-doubled ref would be easy to miss.
 */
test("history --save with several --name flags stores ONE combined result, not one per name", async () => {
  const saved = await runCli(
    [
      "history",
      "--service",
      "demo-app",
      "--name",
      "container.cpu.usage",
      "--name",
      "container.memory.usage",
      "--interval",
      "10m",
      "--save",
      ...WINDOW,
      ...targetArgs(),
    ],
    env(),
  );

  expect(saved.exitCode).toBe(0);
  const refs = [...saved.stdout.matchAll(/ref=(\S+)/g)].map((match) => match[1] ?? "");
  expect(refs).toHaveLength(1);

  const shown = await runCli(["result", "show", refs[0] ?? "", "--format", "json"], env());
  expect(shown.exitCode).toBe(0);
  const rows = JSON.parse(shown.stdout) as readonly Record<string, unknown>[];
  expect(new Set(rows.map((row) => row["NAME"]))).toEqual(
    new Set(["container.cpu.usage", "container.memory.usage"]),
  );
});

/**
 * The multi-unit guard is the whole point of `--unit`, and until this test the
 * branch had no coverage at all — the fixture was entirely single-unit, so the
 * warning never fired in CI even though it fires against real data.
 */
test("history warns, without failing, when one metric name reports several units", async () => {
  const result = await runCli(
    ["history", "--service", "dual-app", "--name", "container.cpu.usage", "--interval", "10m", "--format", "json", ...WINDOW, ...targetArgs()],
    env(),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("2 different units");
  expect(result.stderr).toContain("NOT meaningful");
  // The warning is advisory: rows are still produced, and still on stdout only.
  const rows = JSON.parse(result.stdout) as readonly Record<string, unknown>[];
  expect(rows.length).toBeGreaterThan(0);
});

test("history --unit narrows to one series and drops the multi-unit warning", async () => {
  const cores = await runCli(
    [
      "history",
      "--service",
      "dual-app",
      "--name",
      "container.cpu.usage",
      "--unit",
      "cpu",
      "--interval",
      "1h",
      "--format",
      "json",
      ...WINDOW,
      ...targetArgs(),
    ],
    env(),
  );

  expect(cores.exitCode).toBe(0);
  expect(cores.stderr).not.toContain("different units");
  const rows = JSON.parse(cores.stdout) as readonly Record<string, number>[];
  // Only the two unit="cpu" points (0.016, 0.018) — never blended with the
  // unit="1" series (0.28, 0.3), which would pull the average to ~0.15.
  expect(rows).toHaveLength(1);
  expect(rows[0]?.["AVG"]).toBeCloseTo(0.017, 5);
  expect(rows[0]?.["MAX"]).toBeCloseTo(0.018, 5);
  expect(rows[0]?.["DOC_COUNT"]).toBe(2);
});

test("history with a single --name keeps its original shape, with no NAME column added", async () => {
  const result = await runCli(
    ["history", "--service", "demo-app", "--name", "container.cpu.usage", "--interval", "10m", "--format", "json", ...WINDOW, ...targetArgs()],
    env(),
  );

  expect(result.exitCode).toBe(0);
  const rows = JSON.parse(result.stdout) as readonly Record<string, unknown>[];
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(Object.keys(row)).not.toContain("NAME");
  }
});
