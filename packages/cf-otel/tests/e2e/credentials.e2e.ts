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

function workingEnv(): Record<string, string> {
  return {
    ...BASE_ENV,
    CF_OTEL_FAKE_DASHBOARDS_URL: fakeOpenSearch.url,
    CF_OTEL_FAKE_DASHBOARDS_USERNAME: FAKE_USERNAME,
    CF_OTEL_FAKE_DASHBOARDS_PASSWORD: FAKE_PASSWORD,
  };
}

function envWithBrokenKey1(): Record<string, string> {
  return { ...workingEnv(), CF_OTEL_FAKE_CF_KEY1_BROKEN: "1" };
}

/** The `cf` calls the fake recorded, in order, so a test can pin both the set and the sequence. */
async function readTrace(traceFile: string): Promise<readonly Record<string, unknown>[]> {
  return (await readFile(traceFile, "utf8"))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * The mint path needs a clean miss: pinning `--service-key key1` excludes
 * key2 from the key candidates (`--service-key`/`--fallback-binding-app`
 * restrict only their own binding type — see `applyNameFilters` in
 * `@saptools/core`), and `--fallback-binding-app no-such-app` excludes the
 * "legacy-app" binding the same way. That leaves only key1, which
 * `CF_OTEL_FAKE_CF_KEY1_BROKEN=1` makes unusable.
 */
const MINT_ARGS = [
  "count",
  "--service",
  "service-a",
  "--allow-mint-credential",
  "--service-key",
  "key1",
  "--fallback-binding-app",
  "no-such-app",
];

test("falls back to a pre-SAML app binding end to end when both service keys lack dashboards creds", async () => {
  const result = await runCli(
    ["count", "--service", "service-a", ...targetArgs()],
    { ...envWithBrokenKey1(), CF_OTEL_FAKE_CF_KEY2_BROKEN: "1" },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("3");
});

test("reports every attempted step with --verbose when falling back", async () => {
  const result = await runCli(
    ["count", "--service", "service-a", "--verbose", ...targetArgs()],
    { ...envWithBrokenKey1(), CF_OTEL_FAKE_CF_KEY2_BROKEN: "1" },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain('service key "key1": no dashboards-username/dashboards-password (created after SAML was enabled)');
  expect(result.stderr).toContain('service key "key2": no dashboards-username/dashboards-password (created after SAML was enabled)');
  expect(result.stderr).toContain("resolved dashboards credential from binding:legacy-app");
});

/**
 * Candidates are probed a bounded batch at a time rather than strictly one
 * after another, so a broken key *is* still read — unlike the pre-migration
 * table-scraping mechanism's "never even tried" property. What still holds,
 * and what actually matters, is which credential gets used: the newest
 * working key (key2), even though key1 (older, broken) is probed too.
 */
test("resolves the newest working service key even though an older, broken candidate is probed too", async () => {
  const traceFile = join(tmpdir(), `cf-otel-key-order-${String(process.pid)}.jsonl`);
  await rm(traceFile, { force: true });
  try {
    const result = await runCli(["count", "--service", "service-a", "--verbose", ...targetArgs()], {
      ...envWithBrokenKey1(),
      CF_OTEL_FAKE_CF_TRACE_FILE: traceFile,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("resolved dashboards credential from service-key:key2");

    const traceLines = await readTrace(traceFile);
    // One listing request replaces the old per-app `cf env` scan entirely.
    expect(traceLines.filter((entry) => entry["kind"] === "list-bindings")).toHaveLength(1);
    expect(traceLines.filter((entry) => entry["kind"] === "env")).toHaveLength(0);
  } finally {
    await rm(traceFile, { force: true });
  }
});

/**
 * The fake `cf target` reports a session already pointing at exactly the
 * org/space these tests ask for — the common case for a developer who has
 * just run `cf login`. That session is reused as-is: no isolated login, no
 * temporary CF_HOME, no `cf services`/`cf service-keys`/`cf env` (the v3
 * listing replaces all three), and no SAP credentials required. This is the
 * headline new capability this migration adds to cf-otel.
 */
test("reuses the current cf session when it matches: no login, no legacy discovery commands, no SAP credentials needed", async () => {
  const traceFile = join(tmpdir(), `cf-otel-ambient-${String(process.pid)}.jsonl`);
  await rm(traceFile, { force: true });
  try {
    const result = await runCli(["count", "--service", "service-a", "--verbose", ...targetArgs()], {
      ...envWithBrokenKey1(),
      SAP_EMAIL: "",
      SAP_PASSWORD: "",
      CF_OTEL_FAKE_CF_TRACE_FILE: traceFile,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("reusing the current 'cf target' session");

    const traceLines = await readTrace(traceFile);
    const kinds = traceLines.map((entry) => entry["kind"]);
    expect(kinds).not.toContain("api");
    expect(kinds).not.toContain("auth");
    expect(kinds).not.toContain("target-space");
    expect(kinds).not.toContain("services");
    expect(kinds).not.toContain("service-keys");
    expect(kinds).not.toContain("env");
    expect(kinds).toContain("list-instances");
    // Every command ran in the user's own session, never a temporary CF_HOME.
    for (const entry of traceLines) {
      const cfHome = entry["cfHome"];
      expect(typeof cfHome === "string" ? cfHome : "").not.toContain("saptools-cf-otel-");
    }
  } finally {
    await rm(traceFile, { force: true });
  }
});

test("logs in on its own when no cf session is active and SAP credentials are set", async () => {
  const traceFile = join(tmpdir(), `cf-otel-isolated-${String(process.pid)}.jsonl`);
  await rm(traceFile, { force: true });
  try {
    const result = await runCli(["count", "--service", "service-a", "--verbose", ...targetArgs()], {
      ...envWithBrokenKey1(),
      CF_OTEL_FAKE_CF_NO_SESSION: "1",
      CF_OTEL_FAKE_CF_TRACE_FILE: traceFile,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("logging in to https://api.cf.eu10.hana.ondemand.com in an isolated CF_HOME");

    const kinds = (await readTrace(traceFile)).map((entry) => entry["kind"]);
    expect(kinds).toContain("api");
    expect(kinds).toContain("auth");
    expect(kinds).toContain("target-space");
  } finally {
    await rm(traceFile, { force: true });
  }
});

test("fails clearly when no cf session is active and SAP_EMAIL/SAP_PASSWORD are missing", async () => {
  const result = await runCli(["count", "--service", "service-a", ...targetArgs()], {
    ...envWithBrokenKey1(),
    SAP_EMAIL: "",
    SAP_PASSWORD: "",
    CF_OTEL_FAKE_CF_NO_SESSION: "1",
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("no 'cf target' session is active");
  expect(result.stderr).toContain("SAP_EMAIL and SAP_PASSWORD");
  expect(result.stderr).toContain("cf target -o example-org -s space-demo");
});

test("errors instead of guessing when more than one Cloud Logging instance exists in the space", async () => {
  const result = await runCli(["count", "--service", "service-a", ...targetArgs()], {
    ...envWithBrokenKey1(),
    CF_OTEL_FAKE_CF_MULTI_INSTANCE: "1",
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Multiple");
  expect(result.stderr).toContain("service instances found");
  expect(result.stderr).toContain("--service-instance");
});

test("--service-instance disambiguates when more than one instance exists", async () => {
  const result = await runCli(
    ["count", "--service", "service-a", "--service-instance", "cloud-logging", ...targetArgs()],
    { ...envWithBrokenKey1(), CF_OTEL_FAKE_CF_MULTI_INSTANCE: "1" },
  );
  expect(result.exitCode).toBe(0);
});

test("mints a usable key end to end and keeps it, deleting nothing", async () => {
  const traceFile = join(tmpdir(), `cf-otel-mint-ok-${String(process.pid)}.jsonl`);
  await rm(traceFile, { force: true });
  try {
    const result = await runCli([...MINT_ARGS, ...targetArgs()], {
      ...envWithBrokenKey1(),
      CF_OTEL_FAKE_CF_MINTED_KEY_WORKS: "1",
      CF_OTEL_FAKE_CF_TRACE_FILE: traceFile,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("3");
    const kinds = (await readTrace(traceFile)).map((entry) => entry["kind"]);
    expect(kinds).toContain("create-service-key");
    // The minted key IS the credential the command just used.
    expect(kinds).not.toContain("delete-service-key");
  } finally {
    await rm(traceFile, { force: true });
  }
});

test("deletes the key it minted when that key turns out to be unusable, and only after restoring SAML", async () => {
  const traceFile = join(tmpdir(), `cf-otel-mint-cleanup-${String(process.pid)}.jsonl`);
  await rm(traceFile, { force: true });
  try {
    const result = await runCli([...MINT_ARGS, ...targetArgs()], {
      ...envWithBrokenKey1(),
      CF_OTEL_FAKE_CF_TRACE_FILE: traceFile,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("did not contain dashboards-username");

    const trace = await readTrace(traceFile);
    const kinds = trace.map((entry) => entry["kind"]);
    // Disable and restore, and nothing retried past that.
    expect(kinds.filter((kind) => kind === "update-service")).toHaveLength(2);
    const deleteIndex = kinds.indexOf("delete-service-key");
    expect(deleteIndex).toBeGreaterThan(-1);
    // Cleanup must never extend the window in which SSO is disabled, so it
    // comes after the restore's own update-service call.
    expect(deleteIndex).toBeGreaterThan(kinds.lastIndexOf("update-service"));
    const deleted = trace[deleteIndex];
    expect(deleted?.["keyName"]).toMatch(/^cf-otel-[0-9a-f]{8}$/);
    // Without -f a real `cf` prompts on stdin and would hang until the timeout.
    expect(deleted?.["forced"]).toBe(true);
    expect(deleted?.["keyName"]).toBe(trace.find((entry) => entry["kind"] === "create-service-key")?.["keyName"]);
  } finally {
    await rm(traceFile, { force: true });
  }
});

test("names the orphaned key and the recovery command when the cleanup delete itself fails", async () => {
  const result = await runCli([...MINT_ARGS, ...targetArgs()], {
    ...envWithBrokenKey1(),
    CF_OTEL_FAKE_CF_DELETE_KEY_FAILS: "1",
  });

  expect(result.exitCode).not.toBe(0);
  // The minting failure stays the headline; the orphan is appended to it.
  expect(result.stderr).toContain("did not contain dashboards-username");
  expect(result.stderr).toContain("could not be deleted");
  expect(result.stderr).toMatch(/cf delete-service-key cloud-logging cf-otel-[0-9a-f]{8} -f/);
});

/**
 * A `try/finally` alone never ran on Ctrl-C: Node terminates immediately for
 * an *unhandled* SIGINT, so the temporary SAML-params directory survived —
 * and it holds the instance's full params blob, secrets included. Exercised
 * against the real built CLI as a child process, because the defect lives
 * entirely in the process's signal disposition and cannot be reproduced
 * in-process. `CF_OTEL_FAKE_CF_SLOW_MS` pauses the fake exactly inside
 * `update-service`, the window in which the directory exists on disk and is
 * tracked for cleanup.
 */
test("removes the temporary SAML-params directory when interrupted mid-mint, instead of stranding a secrets blob", async () => {
  const { spawn } = await import("node:child_process");
  const { readdirSync } = await import("node:fs");

  const prefix = "cf-otel-saml-";
  const listSamlDirs = (): string[] => readdirSync(tmpdir()).filter((entry) => entry.startsWith(prefix));
  const before = new Set(listSamlDirs());

  const child = spawn("node", [CLI_PATH, ...MINT_ARGS, ...targetArgs()], {
    env: {
      ...process.env,
      CF_OTEL_CF_BIN: FAKE_CF_PATH,
      ...envWithBrokenKey1(),
      CF_OTEL_FAKE_CF_MINTED_KEY_WORKS: "1",
      CF_OTEL_FAKE_CF_SLOW_MS: "20000",
    },
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolve) => {
    child.on("exit", () => {
      resolve();
    });
  });

  await waitFor(
    () => listSamlDirs().some((entry) => !before.has(entry)),
    "the CLI to create its temporary SAML-params directory",
  );

  child.kill("SIGINT");
  await exited;

  expect(listSamlDirs().filter((entry) => !before.has(entry))).toEqual([]);
});
