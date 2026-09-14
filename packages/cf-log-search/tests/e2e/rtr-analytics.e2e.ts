import { test, expect } from "@playwright/test";

import { FAKE_PASSWORD, FAKE_USERNAME, startFakeOpenSearch } from "./fixtures/fake-opensearch.js";
import { BASE_ENV, runCli, targetArgs } from "./helpers.js";

test.describe("RTR analytics", () => {
  test("errors reports a status-code breakdown per app", async () => {
    const fakeOpenSearch = await startFakeOpenSearch();
    const env = { ...BASE_ENV, CF_LOG_SEARCH_FAKE_DASHBOARDS_URL: fakeOpenSearch.url, CF_LOG_SEARCH_FAKE_DASHBOARDS_USERNAME: FAKE_USERNAME, CF_LOG_SEARCH_FAKE_DASHBOARDS_PASSWORD: FAKE_PASSWORD };

    const result = await runCli(["errors", ...targetArgs(), "--format", "json"], env);

    expect(result.exitCode).toBe(0);
    const rows: { APP: string; STATUS: string; DOC_COUNT: number }[] = JSON.parse(result.stdout);
    expect(rows.some((row) => row.STATUS === "500")).toBe(true);
    // The numeric `range: { response_status: { gte: 400 } }` filter clause is easy to get
    // wrong (a string-only comparison silently no-ops on a numeric field, matching every
    // document) — the `some` assertion above wouldn't catch that regression since 500 would
    // still be present alongside leaked 200s. Assert the low-status rows are genuinely absent.
    expect(rows.every((row) => Number(row.STATUS) >= 400)).toBe(true);
    await fakeOpenSearch.close();
  });

  test("latency reports p50/p95/p99 per app", async () => {
    const fakeOpenSearch = await startFakeOpenSearch();
    const env = { ...BASE_ENV, CF_LOG_SEARCH_FAKE_DASHBOARDS_URL: fakeOpenSearch.url, CF_LOG_SEARCH_FAKE_DASHBOARDS_USERNAME: FAKE_USERNAME, CF_LOG_SEARCH_FAKE_DASHBOARDS_PASSWORD: FAKE_PASSWORD };

    const result = await runCli(["latency", ...targetArgs(), "--format", "json"], env);

    expect(result.exitCode).toBe(0);
    const rows: { P50_MS: number | null; P95_MS: number | null; P99_MS: number | null }[] = JSON.parse(result.stdout);
    expect(rows.some((row) => row.P50_MS !== null)).toBe(true);
    expect(
      rows.every((row) => {
        if (row.P50_MS === null || row.P95_MS === null || row.P99_MS === null) {
          return true;
        }
        return row.P50_MS <= row.P95_MS && row.P95_MS <= row.P99_MS;
      }),
    ).toBe(true);
    await fakeOpenSearch.close();
  });

  test("latency --by route buckets by request path", async () => {
    const fakeOpenSearch = await startFakeOpenSearch();
    const env = { ...BASE_ENV, CF_LOG_SEARCH_FAKE_DASHBOARDS_URL: fakeOpenSearch.url, CF_LOG_SEARCH_FAKE_DASHBOARDS_USERNAME: FAKE_USERNAME, CF_LOG_SEARCH_FAKE_DASHBOARDS_PASSWORD: FAKE_PASSWORD };

    const result = await runCli(["latency", "--by", "route", ...targetArgs(), "--format", "json"], env);

    expect(result.exitCode).toBe(0);
    const rows: { BUCKET: string }[] = JSON.parse(result.stdout);
    expect(rows.some((row) => row.BUCKET === "/SystemConfigService/getBrokerConfig()")).toBe(true);
    await fakeOpenSearch.close();
  });

  test("top-routes ranks routes by request count", async () => {
    const fakeOpenSearch = await startFakeOpenSearch();
    const env = { ...BASE_ENV, CF_LOG_SEARCH_FAKE_DASHBOARDS_URL: fakeOpenSearch.url, CF_LOG_SEARCH_FAKE_DASHBOARDS_USERNAME: FAKE_USERNAME, CF_LOG_SEARCH_FAKE_DASHBOARDS_PASSWORD: FAKE_PASSWORD };

    const result = await runCli(["top-routes", ...targetArgs(), "--format", "json"], env);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).length).toBeGreaterThan(0);
    await fakeOpenSearch.close();
  });
});
