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

test("selftime ranks the small trace correctly end to end", async () => {
  const result = await runCli(["selftime", "trace-small", "--format", "json", ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("Root span: root-op");
  const rows: readonly { NAME: string; COUNT: number }[] = JSON.parse(result.stdout);
  const childRow = rows.find((row) => row.NAME === "child-a");
  expect(childRow?.COUNT).toBe(2);
});

test("gaps analyzes real children fetched over HTTP end to end", async () => {
  const result = await runCli(["gaps", "trace-small", "root", "--format", "json", ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("Direct children of root: 2");
});

test("spans paginates past 10000 documents for one trace end to end", async () => {
  const result = await runCli(["spans", "trace-big", "--limit", "5", "--format", "json", ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
  // 1 root + 10050 children = 10051 total, confirming search_after pagination
  // actually walked past OpenSearch's 10000 default max_result_window.
  expect(result.stderr).toContain("total: 10051, not truncated");
});

test("top finds the outlier trace via a real by_trace terms aggregation over HTTP", async () => {
  const result = await runCli(["top", "--service", "service-c", "--format", "json", ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
  const rows: readonly Record<string, unknown>[] = JSON.parse(result.stdout);
  expect(rows).toHaveLength(1);
  // 1 root (20s) + 10050 children (1ms each): the root's own duration dominates.
  expect(rows[0]).toMatchObject({ TRACE_ID: "trace-big", SPAN_COUNT: 10_051, DURATION: "20.000s" });
});

test("detached finds a real candidate trace in the same service and time window end to end", async () => {
  const result = await runCli(["detached", "trace-detached-ref", "--format", "json", ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("serviceName=service-d");
  expect(result.stderr).toContain("1 candidate spans found across 1 other traceId(s) in this window.");
  const rows: readonly Record<string, unknown>[] = JSON.parse(result.stdout);
  expect(rows).toEqual([
    expect.objectContaining({ TRACE_ID: "trace-detached-candidate", SPAN_COUNT: 1, FIRST_SPAN_NAME: "detached-candidate-root" }),
  ]);
});

test("diff compares two real traces fetched over HTTP end to end", async () => {
  const result = await runCli(["diff", "trace-small", "trace-small", "--format", "json", ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
  // Diffing a trace against itself: every row's two sides must be identical.
  expect(result.stderr).toContain("Root A: 1.000s   Root B: 1.000s");
  const rows: readonly Record<string, unknown>[] = JSON.parse(result.stdout);
  const childRow = rows.find((row) => row["NAME"] === "child-a");
  expect(childRow).toMatchObject({ SELF_A: childRow?.["SELF_B"], COUNT_A: 2, COUNT_B: 2, DELTA: "0ns" });
});
