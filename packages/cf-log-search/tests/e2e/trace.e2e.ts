import { test, expect } from "@playwright/test";

import { FAKE_PASSWORD, FAKE_USERNAME, startFakeOpenSearch } from "./fixtures/fake-opensearch.js";
import { BASE_ENV, runCli, targetArgs } from "./helpers.js";

function envFor(url: string): Record<string, string> {
  return { ...BASE_ENV, CF_LOG_SEARCH_FAKE_DASHBOARDS_URL: url, CF_LOG_SEARCH_FAKE_DASHBOARDS_USERNAME: FAKE_USERNAME, CF_LOG_SEARCH_FAKE_DASHBOARDS_PASSWORD: FAKE_PASSWORD };
}

test("trace finds the log row for a known vcap_request_id", async () => {
  const fakeOpenSearch = await startFakeOpenSearch();
  const result = await runCli(["trace", "11111111-1111-4111-8111-111111111111", ...targetArgs(), "--format", "json"], envFor(fakeOpenSearch.url));

  expect(result.exitCode).toBe(0);
  const rows: { KIND: string; SOURCE_TYPE: string }[] = JSON.parse(result.stdout);
  expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ KIND: "log", SOURCE_TYPE: "RTR" })]));
  await fakeOpenSearch.close();
});

test("trace --with-span pulls the correlated span, end to end through the real built CLI", async () => {
  const fakeOpenSearch = await startFakeOpenSearch();
  const result = await runCli(["trace", "11111111-1111-4111-8111-111111111111", "--with-span", ...targetArgs(), "--format", "json"], envFor(fakeOpenSearch.url));

  expect(result.exitCode).toBe(0);
  const rows: { KIND: string; TRACE_ID: string }[] = JSON.parse(result.stdout);
  const spanRow = rows.find((row) => row.KIND === "span");
  expect(spanRow?.TRACE_ID).toBe("deaddeaddeaddeaddeaddeaddeaddead");
  await fakeOpenSearch.close();
});

test("trace on an unknown id exits 0 with a clear stderr notice, not a crash", async () => {
  const fakeOpenSearch = await startFakeOpenSearch();
  const result = await runCli(["trace", "00000000-0000-0000-0000-000000000000", ...targetArgs()], envFor(fakeOpenSearch.url));

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("no logs-cfsyslog-* document");
  await fakeOpenSearch.close();
});
