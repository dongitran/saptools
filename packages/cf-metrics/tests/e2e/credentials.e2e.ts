import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { FAKE_PASSWORD, FAKE_USERNAME, startFakeOpenSearch } from "./fixtures/fake-opensearch.js";
import { BASE_ENV, CLI_PATH, FAKE_CF_PATH, runCli, targetArgs, waitFor } from "./helpers.js";

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

/**
 * The fake `cf target` reports a session already pointing at exactly the
 * org/space these tests ask for — the common case for a developer who has just
 * run `cf login`. That session is reused as-is: no isolated login, no
 * temporary CF_HOME, no `cf services` (the v3 listing replaces it), and no
 * SAP credentials required.
 */
test("reuses the current cf session when it matches: no login, no cf services, no SAP credentials needed", async () => {
  const traceFile = join(tmpdir(), `cf-metrics-ambient-${String(process.pid)}.jsonl`);
  await rm(traceFile, { force: true });
  try {
    const result = await runCli(["names", "--service", "demo-app", "--since", "2026-08-28T09:00:00.000Z", "--verbose", ...targetArgs()], {
      ...envWithBrokenKey(),
      SAP_EMAIL: "",
      SAP_PASSWORD: "",
      CF_METRICS_FAKE_CF_TRACE_FILE: traceFile,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("reusing the current 'cf target' session");

    const traceLines = (await readFile(traceFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const kinds = traceLines.map((entry) => entry["kind"]);
    expect(kinds).not.toContain("api");
    expect(kinds).not.toContain("auth");
    expect(kinds).not.toContain("target-space");
    expect(kinds).not.toContain("services");
    expect(kinds).toContain("list-instances");
    // Every command ran in the user's own session, never a temporary CF_HOME.
    for (const entry of traceLines) {
      const cfHome = entry["cfHome"];
      expect(typeof cfHome === "string" ? cfHome : "").not.toContain("saptools-cf-metrics-");
    }
  } finally {
    await rm(traceFile, { force: true });
  }
});

test("logs in on its own when no cf session is active and SAP credentials are set", async () => {
  const traceFile = join(tmpdir(), `cf-metrics-isolated-${String(process.pid)}.jsonl`);
  await rm(traceFile, { force: true });
  try {
    const result = await runCli(["names", "--service", "demo-app", "--since", "2026-08-28T09:00:00.000Z", "--verbose", ...targetArgs()], {
      ...envWithBrokenKey(),
      CF_METRICS_FAKE_CF_NO_SESSION: "1",
      CF_METRICS_FAKE_CF_TRACE_FILE: traceFile,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("logging in to https://api.cf.eu10.hana.ondemand.com in an isolated CF_HOME");

    const kinds = (await readFile(traceFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as Record<string, unknown>)["kind"]);
    expect(kinds).toContain("api");
    expect(kinds).toContain("auth");
    expect(kinds).toContain("target-space");
  } finally {
    await rm(traceFile, { force: true });
  }
});

test("fails clearly when no cf session is active and SAP_EMAIL/SAP_PASSWORD are missing", async () => {
  const result = await runCli(["names", "--service", "demo-app", "--since", "2026-08-28T09:00:00.000Z", ...targetArgs()], {
    ...envWithBrokenKey(),
    SAP_EMAIL: "",
    SAP_PASSWORD: "",
    CF_METRICS_FAKE_CF_NO_SESSION: "1",
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("no 'cf target' session is active");
  expect(result.stderr).toContain("SAP_EMAIL and SAP_PASSWORD");
  expect(result.stderr).toContain("cf target -o example-org -s space-demo");
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
  const { readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  const prefix = "saptools-cf-metrics-";
  // Read synchronously so the polled predicate below sees the listing as it is
  // at that instant, rather than one resolved a tick later.
  const listSessionDirs = (): string[] => readdirSync(tmpdir()).filter((entry) => entry.startsWith(prefix));
  const before = new Set(listSessionDirs());

  // `CF_METRICS_CF_BIN` must point at the fake `cf`, exactly as `runCli` does:
  // without it the CLI reaches for a real `cf` binary, which fails instantly
  // where none is installed and never opens the session window this test needs.
  // `NO_SESSION` forces the isolated-login path — a matching ambient session
  // would be reused instead and no temporary CF_HOME would ever exist.
  const child = spawn(
    "node",
    [CLI_PATH, "names", "--service", "demo-app", "--since", "2026-08-28T09:00:00.000Z", ...targetArgs()],
    {
      env: {
        ...process.env,
        CF_METRICS_CF_BIN: FAKE_CF_PATH,
        ...envWithBrokenKey(),
        CF_METRICS_FAKE_CF_NO_SESSION: "1",
        CF_METRICS_FAKE_CF_SLOW_MS: "20000",
      },
      stdio: "ignore",
    },
  );
  // Attached before any waiting: the child can exit sooner than expected, and a
  // listener added afterwards would miss the event and hang the test.
  const exited = new Promise<void>((resolve) => {
    child.on("exit", () => {
      resolve();
    });
  });

  // Wait for the session to actually exist rather than guessing a duration —
  // the fixed sleep this replaces was both flaky and, as it turned out, passing
  // for the wrong reason.
  await waitFor(
    () => listSessionDirs().some((entry) => !before.has(entry)),
    "the CLI to create its temporary CF_HOME",
  );

  child.kill("SIGINT");
  await exited;

  expect(listSessionDirs().filter((entry) => !before.has(entry))).toEqual([]);
});
