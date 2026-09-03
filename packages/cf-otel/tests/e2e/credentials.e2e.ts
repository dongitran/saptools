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

function workingEnv(): Record<string, string> {
  return {
    ...BASE_ENV,
    CF_OTEL_FAKE_DASHBOARDS_URL: fakeOpenSearch.url,
    CF_OTEL_FAKE_DASHBOARDS_USERNAME: FAKE_USERNAME,
    CF_OTEL_FAKE_DASHBOARDS_PASSWORD: FAKE_PASSWORD,
  };
}

function envWithBrokenKey(): Record<string, string> {
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
 * The mint path needs both earlier steps to fail: a broken service key, and a
 * fallback binding app the fake does not know, so `cf env` errors out.
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

test("resolves a service key end to end from CF CLI v8's nested credentials payload", async () => {
  // The shape a current `cf service-key` returns. Reading only the top level
  // made every --service-key lookup silently resolve nothing.
  const result = await runCli(["count", "--service", "service-a", "--verbose", ...targetArgs()], workingEnv());

  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("3");
  expect(result.stderr).toContain("resolved dashboards credential from service-key:key2");
});

test("still resolves the flat CF CLI v7 service-key payload", async () => {
  const result = await runCli(["count", "--service", "service-a", "--verbose", ...targetArgs()], {
    ...workingEnv(),
    CF_OTEL_FAKE_CF_KEY_SHAPE: "flat",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("3");
  expect(result.stderr).toContain("resolved dashboards credential from service-key:key2");
});

test("reads key names from the CF CLI v6 single-column service-keys table as well as v8's", async () => {
  const result = await runCli(["count", "--service", "service-a", "--verbose", ...targetArgs()], {
    ...workingEnv(),
    CF_OTEL_FAKE_CF_SERVICE_KEYS_SHAPE: "v6",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("resolved dashboards credential from service-key:key2");
});

test("mints a usable key end to end and keeps it, deleting nothing", async () => {
  const traceFile = join(tmpdir(), `cf-otel-mint-ok-${String(process.pid)}.jsonl`);
  await rm(traceFile, { force: true });
  try {
    const result = await runCli([...MINT_ARGS, ...targetArgs()], {
      ...envWithBrokenKey(),
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
      ...envWithBrokenKey(),
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
    ...envWithBrokenKey(),
    CF_OTEL_FAKE_CF_DELETE_KEY_FAILS: "1",
  });

  expect(result.exitCode).not.toBe(0);
  // The minting failure stays the headline; the orphan is appended to it.
  expect(result.stderr).toContain("did not contain dashboards-username");
  expect(result.stderr).toContain("could not be deleted");
  expect(result.stderr).toMatch(/cf delete-service-key cloud-logging cf-otel-[0-9a-f]{8} -f/);
});

test("lists the services exactly once when auto-discovering and then falling back to a bound app", async () => {
  // `cf services` is the most expensive command in the discovery path: the CF
  // CLI implements it as one request per instance in the space, measured at
  // 11.8s and 15.9s in one traced cold run on a real tenant. Instance
  // discovery and the fallback-binding step used to fetch it separately, even
  // though the second only needed the bound apps off the row the first already
  // had.
  const traceFile = join(tmpdir(), `cf-otel-services-count-${String(process.pid)}.jsonl`);
  await rm(traceFile, { force: true });
  try {
    const result = await runCli(["count", "--service", "service-a", ...targetArgs()], {
      ...envWithBrokenKey(),
      CF_OTEL_FAKE_CF_TRACE_FILE: traceFile,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("3");

    const kinds = (await readTrace(traceFile)).map((entry) => entry["kind"]);
    expect(kinds.filter((kind) => kind === "services")).toHaveLength(1);
    // Proof the fallback step really ran and was served from that one listing.
    expect(kinds).toContain("env");
  } finally {
    await rm(traceFile, { force: true });
  }
});
