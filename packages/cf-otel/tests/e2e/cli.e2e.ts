import { mkdtemp, rm } from "node:fs/promises";
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

function env(): Record<string, string> {
  return {
    ...BASE_ENV,
    CF_OTEL_FAKE_DASHBOARDS_URL: fakeOpenSearch.url,
    CF_OTEL_FAKE_DASHBOARDS_USERNAME: FAKE_USERNAME,
    CF_OTEL_FAKE_DASHBOARDS_PASSWORD: FAKE_PASSWORD,
  };
}

test("sample dumps full unfiltered documents end to end", async () => {
  const result = await runCli(["sample", "--service", "service-b", "--format", "json", ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
  const docs: readonly Record<string, unknown>[] = JSON.parse(result.stdout);
  expect(docs[0]).toMatchObject({ traceId: "trace-findable", serviceName: "service-b" });
});

test("find locates a trace by service and name pattern end to end", async () => {
  const result = await runCli(
    ["find", "--service", "service-b", "--name", "*SyncBatchAction*", "--format", "json", ...targetArgs()],
    env(),
  );
  expect(result.exitCode).toBe(0);
  const rows: readonly Record<string, unknown>[] = JSON.parse(result.stdout);
  expect(rows[0]).toMatchObject({ TRACE_ID: "trace-findable" });
});

test("mapping reports a real keyword field's type end to end", async () => {
  const result = await runCli(["mapping", "--field", "serviceName", "--format", "json", ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([{ FIELD: "serviceName", TYPE: "keyword", IGNORE_ABOVE: 256 }]);
});

test("prints the resolved-target notice to stderr for an explicit target", async () => {
  const result = await runCli(["count", "--service", "service-b", ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("cf-otel: target eu10/example-org/space-demo (explicit)");
});

test("fails clearly with a non-zero exit code on an invalid --format", async () => {
  const result = await runCli(["find", "--service", "service-b", "--format", "yaml", ...targetArgs()], env());
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Invalid --format");
});

test("--save then result show round-trips the exact same rows end to end", async () => {
  // CF_OTEL_RESULTS_ROOT keeps this test from touching the real ~/.saptools
  // directory (mirrors CF_OTEL_CF_BIN's test-only override for the cf binary).
  const resultsRoot = await mkdtemp(join(tmpdir(), "cf-otel-results-"));
  try {
    const saveEnv = { ...env(), CF_OTEL_RESULTS_ROOT: resultsRoot };
    const saved = await runCli(["find", "--service", "service-b", "--format", "json", "--save", ...targetArgs()], saveEnv);
    expect(saved.exitCode).toBe(0);
    const ref = saved.stdout.trim().replace(/^ref=/, "");
    expect(ref).toMatch(/^[0-9a-f]{8}$/);

    const shown = await runCli(["result", "show", ref, "--format", "json"], saveEnv);
    expect(shown.exitCode).toBe(0);
    const rows: readonly Record<string, unknown>[] = JSON.parse(shown.stdout);
    expect(rows[0]).toMatchObject({ TRACE_ID: "trace-findable" });

    const listed = await runCli(["result", "list"], saveEnv);
    expect(listed.stdout).toContain(ref);

    const cleared = await runCli(["result", "clear"], saveEnv);
    expect(cleared.stdout.trim()).toBe("removed=1");
  } finally {
    await rm(resultsRoot, { recursive: true, force: true });
  }
});
