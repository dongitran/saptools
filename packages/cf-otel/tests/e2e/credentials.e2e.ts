import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function envWithBrokenKey(): Record<string, string> {
  return {
    ...BASE_ENV,
    CF_OTEL_FAKE_DASHBOARDS_URL: fakeOpenSearch.url,
    CF_OTEL_FAKE_DASHBOARDS_USERNAME: FAKE_USERNAME,
    CF_OTEL_FAKE_DASHBOARDS_PASSWORD: FAKE_PASSWORD,
    CF_OTEL_FAKE_CF_KEY1_BROKEN: "1",
  };
}

test("falls back to a pre-SAML app binding end to end when the service key lacks dashboards creds", async () => {
  const result = await runCli(["count", "--service", "service-a", ...targetArgs()], envWithBrokenKey());
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("3");
});

test("reports every attempted step with --verbose when falling back", async () => {
  const result = await runCli(["count", "--service", "service-a", "--verbose", ...targetArgs()], envWithBrokenKey());
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain('service key "key1": payload had no dashboards-username/dashboards-password');
  expect(result.stderr).toContain("resolved dashboards credential from fallback-binding:legacy-app");
});

test("tries service keys newest-first: the last-listed key is attempted, and the first-listed one is never even tried", async () => {
  const traceFile = join(tmpdir(), `cf-otel-key-order-${String(process.pid)}.jsonl`);
  await rm(traceFile, { force: true });
  try {
    const result = await runCli(["count", "--service", "service-a", ...targetArgs()], {
      ...BASE_ENV,
      CF_OTEL_FAKE_DASHBOARDS_URL: fakeOpenSearch.url,
      CF_OTEL_FAKE_DASHBOARDS_USERNAME: FAKE_USERNAME,
      CF_OTEL_FAKE_DASHBOARDS_PASSWORD: FAKE_PASSWORD,
      CF_OTEL_FAKE_CF_ONLY_KEY2_WORKS: "1",
      CF_OTEL_FAKE_CF_TRACE_FILE: traceFile,
    });
    expect(result.exitCode).toBe(0);

    const traceLines = (await readFile(traceFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const serviceKeyCalls = traceLines.filter((entry) => entry["kind"] === "service-key");
    // Only key2 should ever be attempted: it works, and it must be tried
    // before key1 (which "cf service-keys" lists first) for this to hold —
    // if the reversal were broken, key1 would be tried (and fail) too.
    expect(serviceKeyCalls).toEqual([{ kind: "service-key", instance: "cloud-logging", keyName: "key2" }]);
  } finally {
    await rm(traceFile, { force: true });
  }
});

test("fails with SAP_EMAIL/SAP_PASSWORD missing before ever contacting Cloud Foundry", async () => {
  const result = await runCli(["count", "--service", "service-a", ...targetArgs()], {
    ...envWithBrokenKey(),
    SAP_EMAIL: "",
    SAP_PASSWORD: "",
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("SAP_EMAIL and SAP_PASSWORD environment variables are required");
});
