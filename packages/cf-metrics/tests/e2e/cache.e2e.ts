import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { FAKE_PASSWORD, FAKE_USERNAME, startFakeOpenSearch } from "./fixtures/fake-opensearch.js";
import { BASE_ENV, runCli, targetArgs } from "./helpers.js";

/**
 * The credential cache end to end, against the real built CLI: a cold run
 * discovers through the fake `cf`, a warm run must not spawn `cf` at all, and
 * a cached credential the fake OpenSearch rejects is dropped and rediscovered
 * within the same command.
 */

let fakeOpenSearch: Awaited<ReturnType<typeof startFakeOpenSearch>>;
let saptoolsRoot: string;
let traceFile: string;

const NAMES = ["names", "--service", "demo-app", "--since", "2026-08-28T09:00:00.000Z", "--format", "json"];

test.beforeAll(async () => {
  fakeOpenSearch = await startFakeOpenSearch();
});

test.afterAll(async () => {
  await fakeOpenSearch.close();
});

test.beforeEach(async () => {
  saptoolsRoot = await mkdtemp(join(tmpdir(), "cf-metrics-e2e-cache-"));
  traceFile = join(saptoolsRoot, "cf-trace.jsonl");
});

test.afterEach(async () => {
  await rm(saptoolsRoot, { recursive: true, force: true });
});

function env(): Record<string, string> {
  return {
    ...BASE_ENV,
    CF_METRICS_CREDENTIAL_CACHE: "1",
    CF_METRICS_SAPTOOLS_ROOT: saptoolsRoot,
    CF_METRICS_FAKE_DASHBOARDS_URL: fakeOpenSearch.url,
    CF_METRICS_FAKE_DASHBOARDS_USERNAME: FAKE_USERNAME,
    CF_METRICS_FAKE_DASHBOARDS_PASSWORD: FAKE_PASSWORD,
    CF_METRICS_FAKE_CF_TRACE_FILE: traceFile,
  };
}

async function cfCallKinds(): Promise<readonly unknown[]> {
  try {
    return (await readFile(traceFile, "utf8"))
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as Record<string, unknown>)["kind"]);
  } catch {
    return [];
  }
}

function cacheFile(): string {
  return join(saptoolsRoot, "cf-metrics", "credentials.json");
}

test("a warm run reuses the cached credential and never spawns cf; --refresh-credential rediscovers", async () => {
  const cold = await runCli([...NAMES, ...targetArgs()], env());
  expect(cold.exitCode).toBe(0);
  expect(JSON.parse(cold.stdout)).not.toEqual([]);
  expect(await cfCallKinds()).toContain("list-bindings");
  expect((await stat(cacheFile()).then((s) => s.mode & 0o777)).toString(8)).toBe("600");

  await rm(traceFile, { force: true });
  const warm = await runCli([...NAMES, "--verbose", ...targetArgs()], env());
  expect(warm.exitCode).toBe(0);
  expect(JSON.parse(warm.stdout)).toEqual(JSON.parse(cold.stdout));
  expect(warm.stderr).toContain("using cached dashboards credential from service-key:key2");
  expect(await cfCallKinds()).toEqual([]);

  await rm(traceFile, { force: true });
  const refreshed = await runCli([...NAMES, "--refresh-credential", ...targetArgs()], env());
  expect(refreshed.exitCode).toBe(0);
  expect(await cfCallKinds()).toContain("list-bindings");
});

test("a cache hit is silent without --verbose, and stdout stays parseable", async () => {
  await runCli([...NAMES, ...targetArgs()], env());

  const warm = await runCli([...NAMES, ...targetArgs()], env());

  expect(warm.exitCode).toBe(0);
  expect(warm.stderr).not.toContain("cached");
  expect(() => {
    JSON.parse(warm.stdout);
  }).not.toThrow();
});

test("credential list shows the entry without its secret, and credential clear forgets it", async () => {
  await runCli([...NAMES, ...targetArgs()], env());

  const listed = await runCli(["credential", "list", "--format", "json"], env());
  expect(listed.exitCode).toBe(0);
  const rows = JSON.parse(listed.stdout) as readonly Record<string, unknown>[];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ TARGET: "eu10/example-org/space-demo", INSTANCE: "cloud-logging", SOURCE: "service-key:key2" });
  expect(listed.stdout).not.toContain(FAKE_PASSWORD);
  expect(listed.stdout).not.toContain(FAKE_USERNAME);

  const cleared = await runCli(["credential", "clear"], env());
  expect(cleared.exitCode).toBe(0);
  expect(cleared.stdout.trim()).toBe("removed=1");
  await expect(stat(cacheFile())).rejects.toThrow(/ENOENT/);

  await rm(traceFile, { force: true });
  const afterClear = await runCli([...NAMES, ...targetArgs()], env());
  expect(afterClear.exitCode).toBe(0);
  expect(await cfCallKinds()).toContain("list-bindings");
});

/**
 * The key or binding a cached credential came from can be deleted at any
 * time. The user cannot tell that from a permission problem and should not
 * have to: the command drops the entry, rediscovers, retries, and says so.
 */
test("a cached credential OpenSearch rejects is dropped and rediscovered within the same command", async () => {
  await runCli([...NAMES, ...targetArgs()], env());
  const stored = JSON.parse(await readFile(cacheFile(), "utf8")) as { version: 1; entries: Record<string, unknown>[] };
  expect(stored.entries).toHaveLength(1);
  stored.entries[0] = { ...stored.entries[0], password: "no-longer-valid" };
  await writeFile(cacheFile(), JSON.stringify(stored), "utf8");
  await rm(traceFile, { force: true });

  const result = await runCli([...NAMES, ...targetArgs()], env());

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("was rejected");
  expect(result.stderr).toContain("rediscovering");
  expect(JSON.parse(result.stdout)).not.toEqual([]);
  expect(await cfCallKinds()).toContain("list-bindings");
  const repaired = JSON.parse(await readFile(cacheFile(), "utf8")) as { entries: Record<string, unknown>[] };
  expect(repaired.entries[0]?.["password"]).toBe(FAKE_PASSWORD);
});

test("CF_METRICS_CREDENTIAL_CACHE=0 leaves nothing on disk", async () => {
  const result = await runCli([...NAMES, ...targetArgs()], { ...env(), CF_METRICS_CREDENTIAL_CACHE: "0" });

  expect(result.exitCode).toBe(0);
  await expect(stat(cacheFile())).rejects.toThrow(/ENOENT/);
});

test("--service-key pins are honoured against the cache: a credential from another binding is rediscovered", async () => {
  // Cold run resolves from key2 (the newest working key).
  await runCli([...NAMES, ...targetArgs()], env());
  await rm(traceFile, { force: true });

  // Pinning key1 must not be satisfied by the cached key2 credential.
  const pinned = await runCli([...NAMES, "--service-key", "key1", "--verbose", ...targetArgs()], env());

  expect(pinned.exitCode).toBe(0);
  expect(pinned.stderr).toContain("resolved dashboards credential from service-key:key1");
  expect(await cfCallKinds()).toContain("list-bindings");
});
