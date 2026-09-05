import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as clientBootstrap from "../../src/cli/client-bootstrap.js";
import { buildProgram } from "../../src/cli/program.js";
import type { OpenSearchClient, SearchHit, SearchResponse } from "../../src/opensearch-client.js";

vi.mock("../../src/cli/client-bootstrap.js", () => ({ withOpenSearchClient: vi.fn() }));

function hit(id: string, source: Record<string, unknown>): SearchHit {
  return { _id: id, _source: source };
}

/**
 * A mapping shaped like a real one: nested on the "." segments, carrying the
 * few fields these tests filter on. An empty mapping would be unrealistic in a
 * way that matters now — an `--attr` key that resolves to no field at all draws
 * a "this filter can only return an empty result" notice, which is the point.
 */
const FAKE_MAPPING = {
  "otel-v1-apm-span-000001": {
    mappings: {
      properties: {
        span: {
          properties: {
            attributes: {
              properties: {
                "http@status_code": { type: "keyword", ignore_above: 256 },
                "http@response@status_code": { type: "integer" },
                "http@request@header@x-vcap-request-id": { type: "keyword", ignore_above: 2048 },
              },
            },
          },
        },
      },
    },
  },
};

function fakeClient(overrides: Partial<OpenSearchClient> = {}): OpenSearchClient {
  return {
    search: async (): Promise<SearchResponse> => ({ totalHits: 0, hits: [] }),
    count: async () => 0,
    getMapping: async () => FAKE_MAPPING,
    ...overrides,
  };
}

function applyExitOverride(command: Command): void {
  command.exitOverride();
  for (const nested of command.commands) {
    applyExitOverride(nested);
  }
}

function buildTestProgram(): Command {
  const program = buildProgram();
  applyExitOverride(program);
  return program;
}

function captureOutput(): { text: () => string } {
  let buffer = "";
  const append = (chunk: unknown): boolean => {
    buffer += String(chunk);
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(append);
  vi.spyOn(process.stderr, "write").mockImplementation(append);
  return { text: () => buffer };
}

async function runCli(args: readonly string[], client: OpenSearchClient): Promise<string> {
  vi.mocked(clientBootstrap.withOpenSearchClient).mockImplementation(async (_opts, work) => await work(client));
  const output = captureOutput();
  await buildTestProgram().parseAsync(["node", "cf-otel", ...args]);
  return output.text();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sample", () => {
  it("dumps full unfiltered documents as JSON", async () => {
    const client = fakeClient({
      search: async () => ({ totalHits: 1, hits: [hit("1", { name: "GET", "span.attributes.http@target": "/x" })] }),
    });
    const text = await runCli(["sample", "--format", "json"], client);
    expect(JSON.parse(text.split("\n").filter((line) => !line.startsWith("cf-otel:")).join("\n"))).toEqual([
      { name: "GET", "span.attributes.http@target": "/x" },
    ]);
  });

  it("rejects --limit 0 with a clear explanation, rather than silently returning zero rows", async () => {
    // Unlike detached/top/spans/diff, --limit here is OpenSearch's own
    // `size` — 0 there means "return nothing", the opposite of "all".
    const client = fakeClient();
    await expect(runCli(["sample", "--limit", "0"], client)).rejects.toThrow(/would return zero results/);
  });
});

describe("mapping", () => {
  it("prints one field's type and ignore_above", async () => {
    const client = fakeClient({
      getMapping: async () => ({ idx: { mappings: { properties: { name: { type: "keyword", ignore_above: 1024 } } } } }),
    });
    const text = await runCli(["mapping", "--field", "name", "--format", "json"], client);
    expect(JSON.parse(text)).toEqual([{ FIELD: "name", TYPE: "keyword", IGNORE_ABOVE: 1024, ALIAS_OF: "" }]);
  });

  /**
   * The two reasons a lookup can fail used to render identically. Telling a
   * user a field present in every backing index "was not found" sends them
   * hunting for a typo that is not there.
   */
  it("says the indices disagree rather than calling a present field missing", async () => {
    const client = fakeClient({
      getMapping: async () => ({
        idx1: { mappings: { properties: { unit: { type: "keyword" } } } },
        idx2: { mappings: { properties: { unit: { type: "text" } } } },
      }),
    });
    await expect(runCli(["mapping", "--field", "unit"], client)).rejects.toThrow(/mapped inconsistently/);
    await expect(runCli(["mapping", "--field", "unit"], client)).rejects.toThrow(/keyword, text/);
    await expect(runCli(["mapping", "--field", "unit"], client)).rejects.not.toThrow(/was not found/);
  });

  it("still reports a genuinely absent field as not found", async () => {
    const client = fakeClient({ getMapping: async () => ({ idx: { mappings: { properties: {} } } }) });
    await expect(runCli(["mapping", "--field", "nope"], client)).rejects.toThrow(/was not found in the mapping/);
  });

  it("lists every field's type when --field is omitted", async () => {
    const client = fakeClient({
      getMapping: async () => ({
        idx: {
          mappings: {
            properties: {
              name: { type: "keyword", ignore_above: 1024 },
              serviceName: { type: "keyword" },
            },
          },
        },
      }),
    });
    const text = await runCli(["mapping", "--format", "json"], client);
    const rows: readonly Record<string, unknown>[] = JSON.parse(text);
    expect(rows).toContainEqual({ FIELD: "name", TYPE: "keyword", IGNORE_ABOVE: 1024, ALIAS_OF: "" });
    expect(rows).toContainEqual({ FIELD: "serviceName", TYPE: "keyword", IGNORE_ABOVE: "", ALIAS_OF: "" });
  });

  it("fails clearly for an unknown field", async () => {
    const client = fakeClient({ getMapping: async () => ({ idx: { mappings: { properties: {} } } }) });
    await expect(runCli(["mapping", "--field", "nope"], client)).rejects.toThrow(/was not found in the mapping/);
  });

  it("supports --save like every other command that can return a large row set", async () => {
    const client = fakeClient({
      getMapping: async () => ({ idx: { mappings: { properties: { name: { type: "keyword" } } } } }),
    });
    const text = await runCli(["mapping", "--save"], client);
    expect(text.trim()).toMatch(/^ref=/);
  });
});

describe("--save pre-flight", () => {
  let blocked: string;

  beforeEach(async () => {
    // A plain file where the results root belongs: every path under it fails
    // with ENOTDIR, which is what a store that cannot be written looks like in practice.
    const directory = await mkdtemp(join(tmpdir(), "cf-otel-preflight-"));
    blocked = join(directory, "not-a-directory");
    await writeFile(blocked, "", "utf8");
    vi.stubEnv("CF_OTEL_RESULTS_ROOT", blocked);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(blocked, { force: true });
  });

  it("fails before the CF login and credential discovery that --save would otherwise pay for first", async () => {
    const client = fakeClient();
    vi.mocked(clientBootstrap.withOpenSearchClient).mockImplementation(async (_opts, work) => await work(client));
    captureOutput();

    await expect(
      buildTestProgram().parseAsync(["node", "cf-otel", "mapping", "--save"]),
    ).rejects.toThrow(/--save cannot write to the saved-result store/);

    expect(clientBootstrap.withOpenSearchClient).not.toHaveBeenCalled();
  });

  it("does not run the check for a command invoked without --save", async () => {
    const client = fakeClient({
      getMapping: async () => ({ idx: { mappings: { properties: { name: { type: "keyword" } } } } }),
    });
    const text = await runCli(["mapping"], client);
    expect(text).toContain("name");
  });
});

describe("find", () => {
  it("lists matching traces with duration formatted", async () => {
    const client = fakeClient({
      search: async () => ({
        totalHits: 1,
        hits: [
          hit("1", {
            traceId: "t1",
            spanId: "s1",
            name: "BatchProcessingService - handle SyncBatchAction",
            serviceName: "service-a",
            startTime: "2026-08-28T03:03:42.306Z",
            durationInNanos: 124_236_000_000,
          }),
        ],
      }),
    });
    const text = await runCli(["find", "--service", "service-a", "--format", "json"], client);
    const rows: readonly Record<string, unknown>[] = JSON.parse(text);
    expect(rows[0]).toMatchObject({ TRACE_ID: "t1", SERVICE: "service-a", DURATION: "124.236s" });
  });

  it("rejects --limit 0 with a clear explanation, rather than silently returning zero rows", async () => {
    const client = fakeClient();
    await expect(runCli(["find", "--service", "service-a", "--limit", "0"], client)).rejects.toThrow(
      /would return zero results/,
    );
  });

  it("accepts --sort durationInNanos and rejects an invalid --sort value", async () => {
    const client = fakeClient({ search: async () => ({ totalHits: 0, hits: [] }) });
    await runCli(["find", "--service", "service-a", "--sort", "durationInNanos", "--format", "json"], client);
    await expect(runCli(["find", "--service", "service-a", "--sort", "bogus"], client)).rejects.toThrow(/Invalid --sort/);
  });
});

describe("top", () => {
  it("lists outlier traces from the terms aggregation", async () => {
    const client = fakeClient({
      search: async () => ({
        totalHits: 0,
        hits: [],
        aggregations: {
          by_trace: {
            buckets: [
              {
                key: "t1",
                doc_count: 14,
                min_start: { value_as_string: "2026-08-28T03:03:42.306Z" },
                max_duration: { value: 124_236_000_000 },
                first_hit: { hits: { hits: [{ _source: { name: "root-op" } }] } },
              },
            ],
          },
        },
      }),
    });
    const text = await runCli(["top", "--service", "service-a", "--format", "json"], client);
    const rows: readonly Record<string, unknown>[] = JSON.parse(text);
    expect(rows[0]).toMatchObject({ TRACE_ID: "t1", SPAN_COUNT: 14, NAME: "root-op" });
  });

  it("accepts --sort spanCount and --errors-only, and rejects an invalid --sort value", async () => {
    const client = fakeClient({ search: async () => ({ totalHits: 0, hits: [], aggregations: { by_trace: { buckets: [] } } }) });
    await runCli(["top", "--service", "service-a", "--sort", "spanCount", "--errors-only", "--format", "json"], client);
    await expect(runCli(["top", "--service", "service-a", "--sort", "bogus"], client)).rejects.toThrow(/Invalid --sort/);
  });

  it("treats --limit 0 as 'return every candidate', not zero rows", async () => {
    const buckets = ["t1", "t2", "t3"].map((key) => ({
      key,
      doc_count: 1,
      min_start: { value_as_string: "2026-08-28T03:00:00Z" },
      max_duration: { value: 1000 },
      first_hit: { hits: { hits: [{ _source: { name: "root" } }] } },
    }));
    const client = fakeClient({ search: async () => ({ totalHits: 0, hits: [], aggregations: { by_trace: { buckets } } }) });
    const text = await runCli(["top", "--service", "service-a", "--limit", "0", "--format", "json"], client);
    expect(JSON.parse(text)).toHaveLength(3);
  });

  it("rejects a negative --limit", async () => {
    const client = fakeClient();
    await expect(runCli(["top", "--service", "service-a", "--limit", "-1"], client)).rejects.toThrow(
      /non-negative integer/,
    );
  });

  it("orders the terms aggregation by the requested metric, not just re-sorting client-side", async () => {
    // Regression test: OpenSearch's terms `order` clause decides which
    // 10,000 buckets come back at all, not just their display order. Without
    // an explicit `order` matching --sort, a long-but-low-span-count trace
    // could be truncated away before the client ever sees it.
    let capturedTerms: unknown;
    const client = fakeClient({
      search: async (_index, body) => {
        const aggs = body["aggs"] as { by_trace: { terms: unknown } };
        capturedTerms = aggs.by_trace.terms;
        return { totalHits: 0, hits: [], aggregations: { by_trace: { buckets: [] } } };
      },
    });

    await runCli(["top", "--service", "service-a", "--format", "json"], client);
    expect(capturedTerms).toMatchObject({ order: { max_duration: "desc" } });

    await runCli(["top", "--service", "service-a", "--sort", "spanCount", "--format", "json"], client);
    expect(capturedTerms).toMatchObject({ order: { _count: "desc" } });
  });

  it("warns when more than 10,000 distinct traceIds existed and some were dropped before ranking", async () => {
    const client = fakeClient({
      search: async () => ({
        totalHits: 0,
        hits: [],
        aggregations: { by_trace: { buckets: [], sum_other_doc_count: 42 } },
      }),
    });
    const text = await runCli(["top", "--service", "service-a", "--format", "json"], client);
    expect(text).toContain("WARNING: more than 10,000 distinct traceIds");
  });

  it("does not warn when every distinct traceId fit within the aggregation's bucket cap", async () => {
    const client = fakeClient({
      search: async () => ({
        totalHits: 0,
        hits: [],
        aggregations: { by_trace: { buckets: [], sum_other_doc_count: 0 } },
      }),
    });
    const text = await runCli(["top", "--service", "service-a", "--format", "json"], client);
    expect(text).not.toContain("WARNING");
  });
});

describe("find request-id lookup", () => {
  it("names the missing field instead of reporting an empty result", async () => {
    // A tenant whose collector does not export HTTP request headers.
    const client = fakeClient({ getMapping: async () => ({ idx: { mappings: { properties: {} } } }) });

    await expect(
      runCli(["find", "--vcap-request-id", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"], client),
    ).rejects.toThrow(/x-vcap-request-id" is not present/);
  });

  it("emits a bare trace id array for --format json-compact", async () => {
    const client = fakeClient({
      search: async () => ({
        totalHits: 1,
        hits: [{ _id: "1", _source: { traceId: "abc123", spanId: "s1", name: "GET", serviceName: "svc", startTime: "2026-08-28T04:00:00Z", durationInNanos: 5 } }],
      }),
    });

    const text = await runCli(["find", "--service", "svc", "--format", "json-compact"], client);

    expect(JSON.parse(text.trim())).toEqual(["abc123"]);
  });
});

describe("count", () => {
  it("prints a bare count", async () => {
    const client = fakeClient({ count: async () => 178 });
    const text = await runCli(["count", "t1", "--name", "POST"], client);
    expect(text.trim()).toBe("178");
  });

  it("accepts --trace-ids in place of a positional traceId", async () => {
    const client = fakeClient({ count: async () => 3 });
    const text = await runCli(["count", "--trace-ids", "a,b,c"], client);
    expect(text.trim()).toBe("3");
  });

  it("rejects an empty --vcap-request-id before paying for credential discovery", async () => {
    const client = fakeClient({ count: async () => 0 });

    await expect(runCli(["count", "--vcap-request-id", "   "], client)).rejects.toThrow(/--vcap-request-id was empty/);
  });

  it("supports the full filter set (service/since/until/attr/errors-only)", async () => {
    const client = fakeClient({ count: async () => 0 });
    const text = await runCli(
      ["count", "t1", "--service", "svc", "--since", "24h", "--until", "1h", "--attr", "http@response@status_code>=400", "--errors-only"],
      client,
    );
    expect(text.trim()).toBe("0");
  });

  it("accepts --format without changing the bare-number output, and rejects an invalid value", async () => {
    const client = fakeClient({ count: async () => 178 });
    const text = await runCli(["count", "t1", "--format", "json"], client);
    expect(text.trim()).toBe("178");
    await expect(runCli(["count", "t1", "--format", "yaml"], client)).rejects.toThrow(/Invalid --format/);
  });

  it("rejects a positional traceId combined with --trace-ids", async () => {
    const client = fakeClient({ count: async () => 0 });
    await expect(runCli(["count", "t1", "--trace-ids", "a,b"], client)).rejects.toThrow(
      /either a positional traceId or --trace-ids, not both/,
    );
  });
});

describe("spans", () => {
  it("fetches every span in a trace and reports the total", async () => {
    const client = fakeClient({
      search: async () => ({
        totalHits: 2,
        hits: [
          hit("1", { traceId: "t1", spanId: "s1", name: "POST", kind: "SPAN_KIND_SERVER", serviceName: "a", startTime: "2026-08-28T03:00:00Z", durationInNanos: 1_000_000 }),
          hit("2", { traceId: "t1", spanId: "s2", parentSpanId: "s1", name: "child", kind: "SPAN_KIND_INTERNAL", serviceName: "a", startTime: "2026-08-28T03:00:00Z", durationInNanos: 500_000 }),
        ],
      }),
    });
    const text = await runCli(["spans", "t1", "--format", "json"], client);
    expect(text).toContain('"SPAN_ID": "s1"');
    expect(text).toContain("total: 2, not truncated");
  });

  it("treats --limit 0 as 'display every fetched span', not zero rows", async () => {
    const client = fakeClient({
      search: async () => ({
        totalHits: 3,
        hits: ["s1", "s2", "s3"].map((spanId) => hit(spanId, { traceId: "t1", spanId, name: "GET", durationInNanos: 1000 })),
      }),
    });
    const limited = await runCli(["spans", "t1", "--limit", "1", "--format", "json"], client);
    expect(JSON.parse(limited.split("\n").filter((line) => !line.startsWith("cf-otel:")).join("\n"))).toHaveLength(1);

    const unlimited = await runCli(["spans", "t1", "--limit", "0", "--format", "json"], client);
    expect(JSON.parse(unlimited.split("\n").filter((line) => !line.startsWith("cf-otel:")).join("\n"))).toHaveLength(3);
  });

  it("rejects a negative --limit", async () => {
    const client = fakeClient();
    await expect(runCli(["spans", "t1", "--limit", "-1"], client)).rejects.toThrow(/non-negative integer/);
  });

  it("always fetches traceId/spanId from OpenSearch even when --fields omits them, since hitToSpan requires both", async () => {
    // Regression test for a real bug found against a live Cloud Logging
    // instance: OpenSearch's `_source` filter genuinely restricts the
    // response to exactly the requested fields, so a --fields list (or even
    // the command's own default) that omits traceId/spanId made hitToSpan
    // throw "is missing traceId/spanId" on every single hit, always — the
    // fake test client's canned responses never exercised real _source
    // filtering, which is exactly why this shipped undetected.
    let capturedSource: unknown;
    const client = fakeClient({
      search: async (_index, body) => {
        capturedSource = body["_source"];
        return { totalHits: 1, hits: [hit("1", { traceId: "t1", spanId: "s1", name: "POST", durationInNanos: 1_000_000 })] };
      },
    });
    await runCli(["spans", "t1", "--fields", "name,durationInNanos", "--format", "json"], client);
    expect(capturedSource).toEqual(expect.arrayContaining(["traceId", "spanId"]));
    expect(new Set(capturedSource as string[]).size).toBe((capturedSource as string[]).length);
  });

  it("still only displays the columns the user actually requested via --fields", async () => {
    const client = fakeClient({
      search: async () => ({
        totalHits: 1,
        hits: [hit("1", { traceId: "t1", spanId: "s1", name: "POST", kind: "SPAN_KIND_SERVER", durationInNanos: 1_000_000 })],
      }),
    });
    const text = await runCli(["spans", "t1", "--fields", "name,durationInNanos", "--format", "json"], client);
    const rows: readonly Record<string, unknown>[] = JSON.parse(
      text
        .split("\n")
        .filter((line) => !line.startsWith("cf-otel:"))
        .join("\n"),
    );
    expect(rows[0]).toEqual({ NAME: "POST", DURATION: "1.000ms", DURATION_NANOS: 1_000_000 });
  });

  it("rejects an unknown --fields name instead of printing empty rows", async () => {
    // Before validation, an unrecognized name matched no column builder, so
    // every row came out as `{}` at exit 0 — and because the name is also
    // forwarded as an OpenSearch `_source` filter, the document really did
    // come back without it, leaving nothing downstream able to notice.
    const client = fakeClient();
    await expect(runCli(["spans", "t1", "--fields", "duration"], client)).rejects.toThrow(
      /unknown field "duration"/,
    );
  });

  it("lists every valid field name in the rejection message", async () => {
    const client = fakeClient();
    await expect(runCli(["spans", "t1", "--fields", "nope"], client)).rejects.toThrow(
      /spanId, parentSpanId, name, kind, serviceName, startTime, durationInNanos, status\.code/,
    );
  });

  it("reports every unknown name at once, plurally", async () => {
    const client = fakeClient();
    await expect(runCli(["spans", "t1", "--fields", "name,nope,alsoNope"], client)).rejects.toThrow(
      /unknown fields "nope", "alsoNope"/,
    );
  });

  it("rejects traceId, which is the command's own argument and has no column", async () => {
    const client = fakeClient();
    await expect(runCli(["spans", "t1", "--fields", "traceId"], client)).rejects.toThrow(
      /unknown field "traceId"/,
    );
  });

  it.each([",", " , ", ""])("rejects a --fields value of %j that names nothing", async (value) => {
    const client = fakeClient();
    await expect(runCli(["spans", "t1", "--fields", value], client)).rejects.toThrow(/names no fields/);
  });

  it("fails before contacting OpenSearch, so an invalid --fields costs no credential discovery", async () => {
    let searched = false;
    const client = fakeClient({
      search: async () => {
        searched = true;
        return { totalHits: 0, hits: [] };
      },
    });
    await expect(runCli(["spans", "t1", "--fields", "nope"], client)).rejects.toThrow(/unknown field/);
    expect(searched).toBe(false);
  });

  it("renders the full column set by default, proving the default is still derived from the builders", async () => {
    const client = fakeClient({
      search: async () => ({
        totalHits: 1,
        hits: [
          hit("1", {
            traceId: "t1",
            spanId: "s2",
            parentSpanId: "s1",
            name: "POST",
            kind: "SPAN_KIND_SERVER",
            serviceName: "svc",
            startTime: "2026-08-28T03:00:00Z",
            durationInNanos: 1_000_000,
            status: { code: 2 },
          }),
        ],
      }),
    });
    const text = await runCli(["spans", "t1", "--format", "json"], client);
    const rows: readonly Record<string, unknown>[] = JSON.parse(
      text
        .split("\n")
        .filter((line) => !line.startsWith("cf-otel:"))
        .join("\n"),
    );
    expect(rows[0]).toEqual({
      SPAN_ID: "s2",
      PARENT_SPAN_ID: "s1",
      NAME: "POST",
      KIND: "SPAN_KIND_SERVER",
      SERVICE: "svc",
      START_TIME: "2026-08-28T03:00:00Z",
      DURATION: "1.000ms",
      DURATION_NANOS: 1_000_000,
      STATUS_CODE: 2,
    });
  });

  it("accepts every valid name individually", async () => {
    const client = fakeClient({
      search: async () => ({ totalHits: 1, hits: [hit("1", { traceId: "t1", spanId: "s1", durationInNanos: 1000 })] }),
    });
    for (const field of ["spanId", "parentSpanId", "name", "kind", "serviceName", "startTime", "durationInNanos", "status.code"]) {
      await expect(runCli(["spans", "t1", "--fields", field, "--format", "json"], client)).resolves.not.toThrow();
    }
  });
});

describe("span", () => {
  it("fetches one span's full document by spanId", async () => {
    const client = fakeClient({
      search: async () => ({ totalHits: 1, hits: [hit("1", { spanId: "s1", name: "GET", "span.attributes.http@target": "/x" })] }),
    });
    const text = await runCli(["span", "t1", "s1", "--format", "json"], client);
    expect(JSON.parse(text)).toEqual([{ spanId: "s1", name: "GET", "span.attributes.http@target": "/x" }]);
  });

  it("requires either a spanId or --name", async () => {
    const client = fakeClient();
    await expect(runCli(["span", "t1"], client)).rejects.toThrow(/either a spanId or --name/);
  });

  it("rejects both a spanId and --name together", async () => {
    const client = fakeClient();
    await expect(runCli(["span", "t1", "s1", "--name", "GET"], client)).rejects.toThrow(/not both/);
  });

  it("rejects --first combined with --all", async () => {
    const client = fakeClient();
    await expect(runCli(["span", "t1", "--name", "GET", "--first", "--all"], client)).rejects.toThrow(/only one of --first or --all/);
  });

  it("finds by --name and --kind, returning every match with --all", async () => {
    const client = fakeClient({
      search: async () => ({
        totalHits: 1,
        hits: [hit("1", { spanId: "s1", name: "GET", kind: "SPAN_KIND_SERVER" })],
      }),
    });
    const text = await runCli(["span", "t1", "--name", "GET", "--kind", "SPAN_KIND_SERVER", "--all", "--format", "json"], client);
    expect(JSON.parse(text)).toEqual([{ spanId: "s1", name: "GET", kind: "SPAN_KIND_SERVER" }]);
  });
});

describe("fields", () => {
  it("lists every flat attribute key on a sample span", async () => {
    const client = fakeClient({
      search: async () => ({
        totalHits: 1,
        hits: [hit("1", { spanId: "s1", name: "GET", "span.attributes.http@target": "/x", "span.attributes.http@status_code": 200 })],
      }),
    });
    const text = await runCli(["fields", "t1", "s1", "--format", "json"], client);
    expect(text).toContain("4 flat attribute keys found");
    expect(JSON.parse(text.split("\n").slice(1).join("\n"))).toEqual([
      { KEY: "name" },
      { KEY: "span.attributes.http@status_code" },
      { KEY: "span.attributes.http@target" },
      { KEY: "spanId" },
    ]);
  });

  it("rejects a spanId combined with --name, like span does", async () => {
    const client = fakeClient();
    await expect(runCli(["fields", "t1", "s1", "--name", "GET"], client)).rejects.toThrow(/not both/);
  });
});

describe("selftime", () => {
  it("ranks spans by self-time descending", async () => {
    const client = fakeClient({
      search: async () => ({
        totalHits: 2,
        hits: [
          hit("1", { traceId: "t1", spanId: "root", name: "root", serviceName: "a", startTime: "2026-08-28T03:00:00.000000000Z", durationInNanos: 1_000_000_000 }),
          hit("2", { traceId: "t1", spanId: "child", parentSpanId: "root", name: "child", serviceName: "a", startTime: "2026-08-28T03:00:00.100000000Z", durationInNanos: 400_000_000 }),
        ],
      }),
    });
    const text = await runCli(["selftime", "t1", "--format", "json"], client);
    expect(text).toContain("Root span: root");
    const rows: readonly Record<string, unknown>[] = JSON.parse(text.split("\n").slice(2).join("\n"));
    expect(rows[0]).toMatchObject({ NAME: "root", SELF_TOTAL_NANOS: 600_000_000 });
  });

  it("adds a --by-service breakdown and --with-samples identifying attributes when requested", async () => {
    const client = fakeClient({
      search: async () => ({
        totalHits: 1,
        hits: [
          hit("1", {
            traceId: "t1",
            spanId: "root",
            name: "root",
            serviceName: "svc-a",
            startTime: "2026-08-28T03:00:00.000000000Z",
            durationInNanos: 1_000_000_000,
            "span.attributes.http@target": "/x",
          }),
        ],
      }),
    });
    const text = await runCli(["selftime", "t1", "--by-service", "--with-samples", "--format", "json"], client);
    expect(text).toContain("--by-service breakdown");
    expect(text).toContain("span.attributes.http@target=");
  });

  it("fails clearly when the trace has no spans at all", async () => {
    const client = fakeClient({ search: async () => ({ totalHits: 0, hits: [] }) });
    await expect(runCli(["selftime", "missing-trace"], client)).rejects.toThrow(/was not found/);
  });

  it("treats --top 0 as 'show every ranked row', not zero rows", async () => {
    const client = fakeClient({
      search: async () => ({
        totalHits: 3,
        hits: ["Alpha", "Beta", "Gamma"].map((name) =>
          hit(name, { traceId: "t1", spanId: name, name, serviceName: "a", startTime: "2026-08-28T03:00:00Z", durationInNanos: 100 }),
        ),
      }),
    });
    const limited = await runCli(["selftime", "t1", "--top", "1", "--format", "json"], client);
    expect(JSON.parse(limited.split("\n").slice(2).join("\n"))).toHaveLength(1);

    const unlimited = await runCli(["selftime", "t1", "--top", "0", "--format", "json"], client);
    expect(JSON.parse(unlimited.split("\n").slice(2).join("\n"))).toHaveLength(3);
  });

  it("rejects a negative --top", async () => {
    const client = fakeClient();
    await expect(runCli(["selftime", "t1", "--top", "-1"], client)).rejects.toThrow(/non-negative integer/);
  });
});

describe("gaps", () => {
  it("analyzes gaps between a parent's direct children", async () => {
    let call = 0;
    const client = fakeClient({
      search: async () => {
        call += 1;
        if (call === 1) {
          return { totalHits: 1, hits: [hit("p", { traceId: "t1", spanId: "parent", name: "parent", startTime: "2026-08-28T03:00:00.000000000Z", durationInNanos: 1_000_000_000 })] };
        }
        return {
          totalHits: 1,
          hits: [hit("c", { traceId: "t1", spanId: "child1", parentSpanId: "parent", name: "child1", startTime: "2026-08-28T03:00:00.100000000Z", durationInNanos: 50_000_000 })],
        };
      },
    });
    const text = await runCli(["gaps", "t1", "parent", "--format", "json"], client);
    expect(text).toContain("Direct children of parent: 1");
  });

  it("accepts --buckets and --filter-next, and rejects a malformed --buckets value", async () => {
    let call = 0;
    const client = fakeClient({
      search: async () => {
        call += 1;
        if (call % 2 === 1) {
          return { totalHits: 1, hits: [hit("p", { traceId: "t1", spanId: "parent", name: "parent", startTime: "2026-08-28T03:00:00.000000000Z", durationInNanos: 1_000_000_000 })] };
        }
        return { totalHits: 0, hits: [] };
      },
    });
    await runCli(["gaps", "t1", "parent", "--buckets", "50,100,300", "--filter-next", "*child*", "--format", "json"], client);
    await expect(runCli(["gaps", "t1", "parent", "--buckets", "not-a-number"], client)).rejects.toThrow(/Invalid --buckets/);
  });

  it("fails clearly when the parent span is not found", async () => {
    const client = fakeClient({ search: async () => ({ totalHits: 0, hits: [] }) });
    await expect(runCli(["gaps", "t1", "missing-span"], client)).rejects.toThrow(/was not found in trace/);
  });
});

describe("detached", () => {
  it("finds candidate traces in the same service/time window", async () => {
    let call = 0;
    const client = fakeClient({
      search: async () => {
        call += 1;
        if (call === 1) {
          return { totalHits: 1, hits: [hit("1", { traceId: "ref", spanId: "s1", serviceName: "a", startTime: "2026-08-28T03:00:00.000000000Z", durationInNanos: 1_000_000 })] };
        }
        return {
          totalHits: 14,
          hits: [],
          aggregations: {
            by_trace: {
              buckets: [
                {
                  key: "other-1",
                  doc_count: 14,
                  min_start: { value_as_string: "2026-08-28T03:00:00Z" },
                  max_duration: { value: 571_000_000 },
                  first_hit: { hits: { hits: [{ _source: { name: "root" } }] } },
                },
              ],
            },
          },
        };
      },
    });
    const text = await runCli(["detached", "ref", "--format", "json"], client);
    expect(text).toContain("14 candidate spans found across 1 other traceId(s) in this window.");
    const rows: readonly Record<string, unknown>[] = JSON.parse(text.split("\n").slice(2).join("\n"));
    expect(rows[0]).toMatchObject({ TRACE_ID: "other-1", SPAN_COUNT: 14 });
  });

  it("rejects a negative --padding", async () => {
    const client = fakeClient();
    await expect(runCli(["detached", "ref", "--padding", "-1"], client)).rejects.toThrow(/non-negative integer/);
  });

  it("warns when more than 10,000 distinct candidate traceIds existed and some were dropped before ranking", async () => {
    let call = 0;
    const client = fakeClient({
      search: async () => {
        call += 1;
        if (call === 1) {
          return { totalHits: 1, hits: [hit("1", { traceId: "ref", spanId: "s1", serviceName: "a", startTime: "2026-08-28T03:00:00.000000000Z", durationInNanos: 1_000_000 })] };
        }
        return { totalHits: 0, hits: [], aggregations: { by_trace: { buckets: [], sum_other_doc_count: 7 } } };
      },
    });
    const text = await runCli(["detached", "ref", "--format", "json"], client);
    expect(text).toContain("WARNING: more than 10,000 distinct candidate traceIds");
  });
});

describe("diff", () => {
  it("compares two traces' self-time breakdowns", async () => {
    let call = 0;
    const client = fakeClient({
      search: async () => {
        call += 1;
        if (call === 1) {
          return { totalHits: 1, hits: [hit("a", { traceId: "A", spanId: "rootA", name: "root", startTime: "2026-08-28T03:00:00Z", durationInNanos: 1_000_000_000 })] };
        }
        return { totalHits: 1, hits: [hit("b", { traceId: "B", spanId: "rootB", name: "root", startTime: "2026-08-28T03:00:00Z", durationInNanos: 700_000_000 })] };
      },
    });
    const text = await runCli(["diff", "A", "B", "--format", "json"], client);
    expect(text).toContain("Root A: 1.000s   Root B: 700.000ms");
    const rows: readonly Record<string, unknown>[] = JSON.parse(text.split("\n").slice(1).join("\n"));
    expect(rows[0]).toMatchObject({ NAME: "root", COUNT_A: 1, COUNT_B: 1 });
  });

  it("treats --top 0 as 'show every row', not zero rows", async () => {
    let call = 0;
    const client = fakeClient({
      search: async () => {
        call += 1;
        const side = call === 1 ? "A" : "B";
        return {
          totalHits: 3,
          hits: ["Alpha", "Beta", "Gamma"].map((name) =>
            hit(`${side}-${name}`, { traceId: side, spanId: `${side}-${name}`, name, durationInNanos: 100 }),
          ),
        };
      },
    });
    const limited = await runCli(["diff", "A", "B", "--top", "1", "--format", "json"], client);
    expect(JSON.parse(limited.split("\n").slice(1).join("\n"))).toHaveLength(1);

    call = 0;
    const unlimited = await runCli(["diff", "A", "B", "--top", "0", "--format", "json"], client);
    expect(JSON.parse(unlimited.split("\n").slice(1).join("\n"))).toHaveLength(3);
  });

  it("rejects a negative --top", async () => {
    const client = fakeClient();
    await expect(runCli(["diff", "A", "B", "--top", "-1"], client)).rejects.toThrow(/non-negative integer/);
  });

  it("accepts every --sort variant and rejects an invalid one", async () => {
    const client = fakeClient({
      search: async () => ({ totalHits: 1, hits: [hit("a", { traceId: "A", spanId: "r", name: "root", startTime: "2026-08-28T03:00:00Z", durationInNanos: 1000 })] }),
    });
    for (const sort of ["pct", "selfA", "selfB"]) {
      await runCli(["diff", "A", "B", "--sort", sort, "--format", "json"], client);
    }
    await expect(runCli(["diff", "A", "B", "--sort", "bogus"], client)).rejects.toThrow(/Invalid --sort/);
  });

  it("--sort selfA changes the displayed row order end to end, and shows 'unknown' roots when neither trace has a single root", async () => {
    let call = 0;
    const client = fakeClient({
      search: async () => {
        call += 1;
        if (call === 1) {
          return {
            totalHits: 3,
            hits: [
              hit("a1", { traceId: "A", spanId: "a-alpha", name: "Alpha", startTime: "2026-08-28T03:00:00Z", durationInNanos: 1000 }),
              hit("a2", { traceId: "A", spanId: "a-beta", name: "Beta", startTime: "2026-08-28T03:00:00Z", durationInNanos: 100 }),
              hit("a3", { traceId: "A", spanId: "a-gamma", name: "Gamma", startTime: "2026-08-28T03:00:00Z", durationInNanos: 900 }),
            ],
          };
        }
        return {
          totalHits: 3,
          hits: [
            hit("b1", { traceId: "B", spanId: "b-alpha", name: "Alpha", startTime: "2026-08-28T03:00:00Z", durationInNanos: 1100 }),
            hit("b2", { traceId: "B", spanId: "b-beta", name: "Beta", startTime: "2026-08-28T03:00:00Z", durationInNanos: 1200 }),
            hit("b3", { traceId: "B", spanId: "b-gamma", name: "Gamma", startTime: "2026-08-28T03:00:00Z", durationInNanos: 900 }),
          ],
        };
      },
    });

    const defaultText = await runCli(["diff", "A", "B", "--format", "json"], client);
    expect(defaultText).toContain("Root A: unknown   Root B: unknown");
    const defaultRows: readonly Record<string, unknown>[] = JSON.parse(defaultText.split("\n").slice(1).join("\n"));
    expect(defaultRows.map((row) => row["NAME"])).toEqual(["Beta", "Alpha", "Gamma"]);

    call = 0;
    const selfAText = await runCli(["diff", "A", "B", "--sort", "selfA", "--format", "json"], client);
    const selfARows: readonly Record<string, unknown>[] = JSON.parse(selfAText.split("\n").slice(1).join("\n"));
    expect(selfARows.map((row) => row["NAME"])).toEqual(["Alpha", "Gamma", "Beta"]);
  });

  it("shows an empty PCT_CHANGE, not a divide-by-zero artifact, for a name with zero self-time in A", async () => {
    let call = 0;
    const client = fakeClient({
      search: async () => {
        call += 1;
        if (call === 1) {
          return { totalHits: 1, hits: [hit("a", { traceId: "A", spanId: "rootA", name: "Shared", startTime: "2026-08-28T03:00:00Z", durationInNanos: 100 })] };
        }
        return {
          totalHits: 2,
          hits: [
            hit("b1", { traceId: "B", spanId: "rootB", name: "Shared", startTime: "2026-08-28T03:00:00Z", durationInNanos: 50 }),
            hit("b2", { traceId: "B", spanId: "b-new", name: "NewInB", startTime: "2026-08-28T03:00:00Z", durationInNanos: 30 }),
          ],
        };
      },
    });
    const text = await runCli(["diff", "A", "B", "--format", "json"], client);
    const rows: readonly Record<string, unknown>[] = JSON.parse(text.split("\n").slice(1).join("\n"));
    expect(rows.find((row) => row["NAME"] === "NewInB")).toMatchObject({ SELF_A: "0ns", PCT_CHANGE: "" });
  });

  it("fails clearly naming trace A specifically when it is not found", async () => {
    const client = fakeClient({ search: async () => ({ totalHits: 0, hits: [] }) });
    await expect(runCli(["diff", "A", "B"], client)).rejects.toThrow(/"A" was not found/);
  });

  it("fails clearly naming trace B specifically when trace A exists but trace B does not", async () => {
    let call = 0;
    const client = fakeClient({
      search: async () => {
        call += 1;
        if (call === 1) {
          return { totalHits: 1, hits: [hit("a", { traceId: "A", spanId: "rootA", name: "root", startTime: "2026-08-28T03:00:00Z", durationInNanos: 1000 })] };
        }
        return { totalHits: 0, hits: [] };
      },
    });
    await expect(runCli(["diff", "A", "B"], client)).rejects.toThrow(/"B" was not found/);
  });
});
