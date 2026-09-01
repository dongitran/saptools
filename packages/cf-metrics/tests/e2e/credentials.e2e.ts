import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { FAKE_PASSWORD, FAKE_USERNAME, startFakeOpenSearch } from "./fixtures/fake-opensearch.js";
import { BASE_ENV, CLI_PATH, runCli, targetArgs } from "./helpers.js";

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
    CF_METRICS_FAKE_DASHBOARDS_URL: fakeOpenSearch.url,
    CF_METRICS_FAKE_DASHBOARDS_USERNAME: FAKE_USERNAME,
    CF_METRICS_FAKE_DASHBOARDS_PASSWORD: FAKE_PASSWORD,
    CF_METRICS_FAKE_CF_KEY1_BROKEN: "1",
  };
}

test("falls back to a pre-SAML app binding end to end when the service key lacks dashboards creds", async () => {
  const result = await runCli(["names", "--service", "demo-app", "--since", "2026-08-28T09:00:00.000Z", ...targetArgs()], envWithBrokenKey());
  expect(result.exitCode).toBe(0);
});

test("reports every attempted step with --verbose when falling back", async () => {
  const result = await runCli(["names", "--service", "demo-app", "--since", "2026-08-28T09:00:00.000Z", "--verbose", ...targetArgs()], envWithBrokenKey());
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain('service key "key1": no dashboards-username/dashboards-password');
  expect(result.stderr).toContain("resolved dashboards credential from binding:legacy-app");
});

/**
 * Candidates are probed a bounded batch at a time rather than strictly one
 * after another, so an unused key *is* read — the previous implementation's
 * "never even tried" property is deliberately gone. What still holds, and what
 * actually matters, is which credential gets used: the newest working key.
 */
test("uses the newest working service key even though lower-priority candidates are probed too", async () => {
  const traceFile = join(tmpdir(), `cf-metrics-key-order-${String(process.pid)}.jsonl`);
  await rm(traceFile, { force: true });
  try {
    const result = await runCli(["names", "--service", "demo-app", "--since", "2026-08-28T09:00:00.000Z", "--verbose", ...targetArgs()], {
      ...BASE_ENV,
      CF_METRICS_FAKE_DASHBOARDS_URL: fakeOpenSearch.url,
      CF_METRICS_FAKE_DASHBOARDS_USERNAME: FAKE_USERNAME,
      CF_METRICS_FAKE_DASHBOARDS_PASSWORD: FAKE_PASSWORD,
      CF_METRICS_FAKE_CF_ONLY_KEY2_WORKS: "1",
      CF_METRICS_FAKE_CF_TRACE_FILE: traceFile,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("resolved dashboards credential from service-key:key2");

    const traceLines = (await readFile(traceFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // One listing request replaces the old per-app `cf env` scan entirely.
    expect(traceLines.filter((entry) => entry["kind"] === "list-bindings")).toHaveLength(1);
    expect(traceLines.filter((entry) => entry["kind"] === "env")).toHaveLength(0);
  } finally {
    await rm(traceFile, { force: true });
  }
});

test("fails with SAP_EMAIL/SAP_PASSWORD missing before ever contacting Cloud Foundry", async () => {
  const result = await runCli(["names", "--service", "demo-app", "--since", "2026-08-28T09:00:00.000Z", ...targetArgs()], {
    ...envWithBrokenKey(),
    SAP_EMAIL: "",
    SAP_PASSWORD: "",
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("SAP_EMAIL and SAP_PASSWORD environment variables are required");
});

test("errors instead of guessing when more than one Cloud Logging instance exists in the space", async () => {
  const result = await runCli(["names", "--service", "demo-app", "--since", "2026-08-28T09:00:00.000Z", ...targetArgs()], {
    ...envWithBrokenKey(),
    CF_METRICS_FAKE_CF_MULTI_INSTANCE: "1",
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Multiple");
  expect(result.stderr).toContain("service instances found");
  expect(result.stderr).toContain("--service-instance");
});

test("--service-instance disambiguates when more than one instance exists", async () => {
  const result = await runCli(
    ["names", "--service", "demo-app", "--since", "2026-08-28T09:00:00.000Z", "--service-instance", "cloud-logging", ...targetArgs()],
    { ...envWithBrokenKey(), CF_METRICS_FAKE_CF_MULTI_INSTANCE: "1" },
  );
  expect(result.exitCode).toBe(0);
});

/**
 * A `try/finally` alone never ran on Ctrl-C: Node terminates immediately for an
 * *unhandled* SIGINT, so the temporary CF_HOME survived — and once `cf auth`
 * has run it holds `.cf/config.json` with the CF access token and a long-lived
 * opaque refresh token. Exercised against the real built CLI as a child
 * process, because the defect lives entirely in the process's signal
 * disposition and cannot be reproduced in-process.
 */
test("removes the temporary CF_HOME when interrupted mid-run, instead of stranding a refresh token", async () => {
  const { spawn } = await import("node:child_process");
  const { readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");

  const prefix = "saptools-cf-metrics-";
  const before = new Set((await readdir(tmpdir())).filter((entry) => entry.startsWith(prefix)));

  const child = spawn(
    "node",
    [CLI_PATH, "names", "--service", "demo-app", "--since", "2026-08-28T09:00:00.000Z", ...targetArgs()],
    { env: { ...process.env, ...envWithBrokenKey(), CF_METRICS_FAKE_CF_SLOW_MS: "8000" }, stdio: "ignore" },
  );

  // Let the session get far enough to have created the directory.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const exited = new Promise<void>((resolve) => {
    child.on("exit", () => {
      resolve();
    });
  });
  child.kill("SIGINT");
  await exited;

  const after = (await readdir(tmpdir())).filter((entry) => entry.startsWith(prefix) && !before.has(entry));
  expect(after).toEqual([]);
});
