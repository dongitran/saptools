import { test, expect } from "@playwright/test";

import { FAKE_PASSWORD, FAKE_USERNAME, startFakeOpenSearch } from "./fixtures/fake-opensearch.js";
import { BASE_ENV, runCli, targetArgs } from "./helpers.js";

test("a credential cached from one command is reused by a second, without a second cf curl round trip", async () => {
  const fakeOpenSearch = await startFakeOpenSearch();
  const saptoolsRoot = `/tmp/cf-log-search-e2e-cache-${String(Date.now())}`;
  const env = {
    ...BASE_ENV,
    CF_LOG_SEARCH_CREDENTIAL_CACHE: "1",
    CF_LOG_SEARCH_SAPTOOLS_ROOT: saptoolsRoot,
    CF_LOG_SEARCH_FAKE_DASHBOARDS_URL: fakeOpenSearch.url,
    CF_LOG_SEARCH_FAKE_DASHBOARDS_USERNAME: FAKE_USERNAME,
    CF_LOG_SEARCH_FAKE_DASHBOARDS_PASSWORD: FAKE_PASSWORD,
    CF_LOG_SEARCH_FAKE_CF_TRACE_FILE: `${saptoolsRoot}-trace.jsonl`,
  };

  const first = await runCli(["count", ...targetArgs()], env);
  expect(first.exitCode).toBe(0);

  const listed = await runCli(["credential", "list", "--format", "json"], env);
  expect(JSON.parse(listed.stdout).length).toBe(1);

  const second = await runCli(["count", ...targetArgs()], env);
  expect(second.exitCode).toBe(0);

  const cleared = await runCli(["credential", "clear"], env);
  expect(cleared.stdout.trim()).toBe("removed=1");

  await fakeOpenSearch.close();
});
