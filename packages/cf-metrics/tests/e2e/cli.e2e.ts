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
    CF_METRICS_FAKE_DASHBOARDS_URL: fakeOpenSearch.url,
    CF_METRICS_FAKE_DASHBOARDS_USERNAME: FAKE_USERNAME,
    CF_METRICS_FAKE_DASHBOARDS_PASSWORD: FAKE_PASSWORD,
  };
}

test("--help lists all eleven commands", async () => {
  const result = await runCli(["--help"], env());
  expect(result.exitCode).toBe(0);
  for (const command of ["sample", "mapping", "fields", "names", "history", "snapshot", "top", "watch", "result", "credential", "self-update"]) {
    expect(result.stdout).toContain(command);
  }
});

test("sample returns the N most recent documents, unfiltered by default limit", async () => {
  const result = await runCli(["sample", "--service", "demo-app", "--format", "json", ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
  const rows = JSON.parse(result.stdout) as readonly Record<string, unknown>[];
  expect(rows).toHaveLength(3);
  expect(rows[0]?.["name"]).toBe("container.cpu.usage");
  expect(rows[0]?.["time"]).toBe("2026-08-28T09:16:00.000Z");
});

test("sample --limit 0 fails fast with a clear error, never sends the request", async () => {
  const result = await runCli(["sample", "--service", "demo-app", "--limit", "0", ...targetArgs()], env());
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("--limit 0 would return zero results");
});

test("sample --limit above OpenSearch's result-window ceiling fails fast with a clear error", async () => {
  const result = await runCli(["sample", "--service", "demo-app", "--limit", "10001", ...targetArgs()], env());
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("exceeds OpenSearch's single-page result-window ceiling of 10000");
});

test("sample --since that is neither a relative duration nor an ISO-8601 timestamp fails fast with a clear error, not a raw backend dump", async () => {
  const result = await runCli(["sample", "--service", "demo-app", "--since", "yesterday", ...targetArgs()], env());
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('Invalid --since value "yesterday"');
  expect(result.stderr).not.toContain("parse_exception");
});

test("mapping --field reports the mapped type", async () => {
  const result = await runCli(["mapping", "--field", "name", "--format", "json", ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
  const rows = JSON.parse(result.stdout) as readonly Record<string, unknown>[];
  expect(rows).toEqual([{ FIELD: "name", TYPE: "keyword", IGNORE_ABOVE: 256 }]);
});

test("mapping --field on an unknown field fails with MAPPING_LOOKUP_FAILED", async () => {
  const result = await runCli(["mapping", "--field", "does-not-exist", ...targetArgs()], env());
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('was not found in the mapping');
});

test("mapping --field on a field with nested properties but no explicit type reports it as object, not unknown", async () => {
  const result = await runCli(["mapping", "--field", "instrumentationScope", "--format", "json", ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
  const rows = JSON.parse(result.stdout) as readonly Record<string, unknown>[];
  expect(rows).toEqual([{ FIELD: "instrumentationScope", TYPE: "object", IGNORE_ABOVE: "" }]);
});

test("fields lists every flat attribute key on a sample document, without guessing", async () => {
  const result = await runCli(["fields", "--service", "demo-app", "--name", "container.cpu.usage", "--format", "json-compact", ...targetArgs()], env());
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("flat attribute keys found");
  expect(result.stderr).toContain("kind=GAUGE");
  const keys = JSON.parse(result.stdout) as readonly string[];
  expect(keys).toContain("value");
  expect(keys).toContain("resource.attributes.sap@cf@app_name");
});

test("fields on a service/name with no matching document fails with METRIC_NOT_FOUND", async () => {
  const result = await runCli(["fields", "--service", "no-such-app", ...targetArgs()], env());
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("No matching metric document found");
});

test("names reports every metric name with its kind, unit, and doc count", async () => {
  const result = await runCli(
    ["names", "--service", "demo-app", "--since", "2026-08-28T09:00:00.000Z", "--until", "2026-08-28T09:20:00.000Z", "--format", "json", ...targetArgs()],
    env(),
  );
  expect(result.exitCode).toBe(0);
  const rows = JSON.parse(result.stdout) as readonly Record<string, unknown>[];
  const byName = new Map(rows.map((row) => [row["NAME"], row]));
  expect(byName.size).toBe(5);
  expect(byName.get("container.cpu.usage")).toMatchObject({ KIND: "GAUGE", UNIT: "1", DOC_COUNT: 4 });
  expect(byName.get("queue.incoming_messages")).toMatchObject({ KIND: "SUM", UNIT: "each", DOC_COUNT: 3 });
  expect(byName.get("http.server.duration")).toMatchObject({ KIND: "HISTOGRAM", UNIT: "ms", DOC_COUNT: 3 });
});

test("names --since that is neither a relative duration nor an ISO-8601 timestamp fails fast with a clear error, not a raw backend dump", async () => {
  const result = await runCli(["names", "--service", "demo-app", "--since", "not-a-time", ...targetArgs()], env());
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('Invalid --since value "not-a-time"');
  expect(result.stderr).not.toContain("parse_exception");
});

test("names --limit 0 returns every metric name instead of an empty table", async () => {
  const result = await runCli(
    ["names", "--service", "demo-app", "--since", "2026-08-28T09:00:00.000Z", "--limit", "0", "--format", "json", ...targetArgs()],
    env(),
  );
  expect(result.exitCode).toBe(0);
  const rows = JSON.parse(result.stdout) as readonly Record<string, unknown>[];
  expect(rows.length).toBe(5);
});

test("names --limit above OpenSearch's result-window ceiling fails fast with a clear error", async () => {
  const result = await runCli(["names", "--service", "demo-app", "--limit", "10001", ...targetArgs()], env());
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("exceeds OpenSearch's single-page result-window ceiling of 10000");
});

/**
 * Standing invariant rather than a single case: `--format json` is only
 * pipeable while every human-facing notice goes to stderr. Individual command
 * tests catch this incidentally (they `JSON.parse(result.stdout)`), but a new
 * command, or a new notice added to an existing one, could reintroduce the
 * leak in a path nothing happens to parse. This pins it across the whole
 * row-returning surface at once.
 */
/**
 * Commands that default `--since` (names, history, top) would otherwise exclude
 * the fixture's fixed 2026-08-28 timestamps and run this check on an empty
 * result — still passing, but proving far less.
 */
const FIXTURE_WINDOW = ["--since", "2026-08-28T00:00:00.000Z", "--until", "2026-08-29T00:00:00.000Z"];

const JSON_COMMANDS: readonly (readonly string[])[] = [
  ["sample", "--service", "demo-app", "--limit", "1"],
  ["fields", "--service", "demo-app"],
  ["names", "--service", "demo-app", ...FIXTURE_WINDOW],
  ["snapshot", "--service", "demo-app"],
  ["top", "--name", "container.memory.usage", ...FIXTURE_WINDOW],
  ["history", "--service", "demo-app", "--name", "container.cpu.usage", "--interval", "10m", ...FIXTURE_WINDOW],
];

for (const argv of JSON_COMMANDS) {
  test(`${argv[0] ?? ""} --format json writes only parseable data to stdout, never a notice`, async () => {
    const result = await runCli([...argv, "--format", "json", ...targetArgs()], env());

    expect(result.exitCode).toBe(0);
    for (const line of result.stdout.split("\n")) {
      expect(line.startsWith("cf-metrics:")).toBe(false);
    }
    expect(() => {
      JSON.parse(result.stdout);
    }).not.toThrow();
    expect((JSON.parse(result.stdout) as readonly unknown[]).length).toBeGreaterThan(0);
  });
}

/**
 * The fake backend's own guard rail, asserted directly. Every command test
 * above passes only because no command sends `unmapped_type` on a `range`
 * clause — but that is worthless as protection unless the fake server would
 * actually reject one. These two tests pin the guard from both sides so it
 * cannot silently rot into a no-op.
 */
async function postRawQuery(body: Record<string, unknown>): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(`${fakeOpenSearch.url}/api/console/proxy?path=metrics-*/_search&method=GET`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${FAKE_USERNAME}:${FAKE_PASSWORD}`).toString("base64")}`,
      "osd-xsrf": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json();
  return { status: response.status, payload };
}

test("the fake backend rejects unmapped_type on a range clause, exactly as the real one does", async () => {
  const { status, payload } = await postRawQuery({
    size: 1,
    query: { bool: { filter: [{ range: { time: { gte: "2026-08-28T09:00:00.000Z", unmapped_type: "date" } } }] } },
  });

  expect(status).toBe(400);
  const error = (payload as { error?: { type?: string; reason?: string } }).error;
  expect(error?.type).toBe("parsing_exception");
  expect(error?.reason).toContain("unmapped_type");
});

test("the fake backend still accepts unmapped_type on a sort clause, where it is legal", async () => {
  const { status } = await postRawQuery({
    size: 1,
    query: { bool: { filter: [{ range: { time: { gte: "2026-08-28T09:00:00.000Z" } } }] } },
    sort: [{ time: { order: "desc", unmapped_type: "date" } }],
  });

  expect(status).toBe(200);
});
