import { expect, test } from "@playwright/test";

import { FAKE_PASSWORD, FAKE_USERNAME, startFakeOpenSearch } from "./fixtures/fake-opensearch.js";
import { BASE_ENV, runCli, targetArgs } from "./helpers.js";

let fakeOpenSearch: Awaited<ReturnType<typeof startFakeOpenSearch>>;

test.beforeAll(async () => {
  fakeOpenSearch = await startFakeOpenSearch();
});

test.afterAll(async () => {
  await fakeOpenSearch.close();
});

function env(): Record<string, string> {
  return {
    ...BASE_ENV,
    CF_LOG_SEARCH_FAKE_DASHBOARDS_URL: fakeOpenSearch.url,
    CF_LOG_SEARCH_FAKE_DASHBOARDS_USERNAME: FAKE_USERNAME,
    CF_LOG_SEARCH_FAKE_DASHBOARDS_PASSWORD: FAKE_PASSWORD,
  };
}

test("search returns matching rows, both RTR and APP-log shapes correctly mapped", async () => {
  const result = await runCli(["search", ...targetArgs(), "--format", "json"], env());

  expect(result.exitCode).toBe(0);
  const rows: { sourceType: string; message: string; traceId: string }[] = JSON.parse(result.stdout);
  const rtrRow = rows.find((row) => row.sourceType === "RTR");
  const appRow = rows.find((row) => row.sourceType === "APP/PROC/WEB");
  expect(rtrRow?.traceId).toBe("deaddeaddeaddeaddeaddeaddeaddead");
  // The e2e-level proof of the unit-tested gotcha: even end-to-end through the
  // real built CLI and a real HTTP round trip, an APP-log row's traceId must
  // never be populated from its trace_id field.
  expect(appRow?.traceId).toBe("");
  expect(appRow?.message).toContain("SystemConfigService");
});

test("--app filters to just that app's rows", async () => {
  const result = await runCli(["search", ...targetArgs(), "--app", "acme-svc-user", "--format", "json"], env());

  const rows: { appName: string }[] = JSON.parse(result.stdout);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((row) => row.appName === "acme-svc-user")).toBe(true);
});

test("count returns a plain number matching the same filter search would use", async () => {
  const result = await runCli(["count", ...targetArgs(), "--app", "acme-svc-config"], env());

  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("4");
});

test("fields with no flags never touches the fake OpenSearch server at all", async () => {
  const result = await runCli(["fields", "--format", "json"], env());

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ FIELD: "@timestamp" })]));
});

test("apps aggregates doc counts per app_name", async () => {
  const result = await runCli(["apps", ...targetArgs(), "--format", "json"], env());

  const rows: { APP: string; DOC_COUNT: number }[] = JSON.parse(result.stdout);
  expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ APP: "acme-svc-config", DOC_COUNT: 4 })]));
});

test("--save prints a ref, and result show retrieves the same rows back", async () => {
  const testEnv = { ...env(), CF_LOG_SEARCH_SAPTOOLS_ROOT: `/tmp/cf-log-search-e2e-${String(Date.now())}` };
  const saved = await runCli(["search", ...targetArgs(), "--save"], testEnv);
  const ref = saved.stdout.trim().replace(/^ref=/, "");
  expect(ref).toMatch(/^[0-9a-f]{8}$/);

  const shown = await runCli(["result", "show", ref, "--format", "json"], testEnv);
  expect(shown.exitCode).toBe(0);
  expect(JSON.parse(shown.stdout).length).toBeGreaterThan(0);
});
