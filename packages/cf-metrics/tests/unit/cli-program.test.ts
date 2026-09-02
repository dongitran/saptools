import type { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as clientBootstrap from "../../src/cli/client-bootstrap.js";
import { buildProgram } from "../../src/cli/program.js";
import { CLI_VERSION } from "../../src/config.js";
import type { OpenSearchClient, SearchHit, SearchResponse } from "../../src/opensearch-client.js";

vi.mock("../../src/cli/client-bootstrap.js", () => ({ withOpenSearchClient: vi.fn() }));

function hit(id: string, source: Record<string, unknown>): SearchHit {
  return { _id: id, _source: source };
}

function fakeClient(overrides: Partial<OpenSearchClient> = {}): OpenSearchClient {
  return {
    search: async (): Promise<SearchResponse> => ({ totalHits: 0, hits: [] }),
    count: async () => 0,
    getMapping: async () => ({}),
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
  await buildTestProgram().parseAsync(["node", "cf-metrics", ...args]);
  return output.text();
}

function stripNotices(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("cf-metrics:"))
    .join("\n");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sample", () => {
  it("dumps full unfiltered documents as JSON", async () => {
    const client = fakeClient({
      search: async () => ({ totalHits: 1, hits: [hit("1", { name: "container.cpu.usage", value: 0.02 })] }),
    });
    const text = await runCli(["sample", "--format", "json"], client);
    expect(JSON.parse(stripNotices(text))).toEqual([{ name: "container.cpu.usage", value: 0.02 }]);
  });

  it("rejects --limit 0 with a clear explanation, rather than silently returning zero rows", async () => {
    const client = fakeClient();
    await expect(runCli(["sample", "--limit", "0"], client)).rejects.toThrow(/would return zero results/);
  });

  it("rejects a --limit above OpenSearch's single-page result-window ceiling before contacting the client", async () => {
    const client = fakeClient();
    await expect(runCli(["sample", "--limit", "10001"], client)).rejects.toThrow(
      /exceeds OpenSearch's single-page result-window ceiling of 10000/,
    );
    expect(clientBootstrap.withOpenSearchClient).not.toHaveBeenCalled();
  });

  it("rejects a --since that is neither a relative duration nor an ISO-8601 timestamp before contacting the client", async () => {
    const client = fakeClient();
    await expect(runCli(["sample", "--since", "yesterday"], client)).rejects.toThrow(/Invalid --since value "yesterday"/);
    expect(clientBootstrap.withOpenSearchClient).not.toHaveBeenCalled();
  });

  it("rejects an --until that is neither a relative duration nor an ISO-8601 timestamp before contacting the client", async () => {
    const client = fakeClient();
    await expect(runCli(["sample", "--until", "next-tuesday"], client)).rejects.toThrow(/Invalid --until value "next-tuesday"/);
    expect(clientBootstrap.withOpenSearchClient).not.toHaveBeenCalled();
  });

  it("accepts a --since that is a valid absolute ISO-8601 timestamp", async () => {
    const client = fakeClient({
      search: async () => ({ totalHits: 1, hits: [hit("1", { name: "container.cpu.usage", value: 0.02 })] }),
    });
    const text = await runCli(["sample", "--since", "2026-08-30T03:00:00Z", "--format", "json"], client);
    expect(JSON.parse(stripNotices(text))).toEqual([{ name: "container.cpu.usage", value: 0.02 }]);
  });
});

describe("mapping", () => {
  it("lists every field's type when --field is omitted", async () => {
    const client = fakeClient({
      getMapping: async () => ({
        idx: { mappings: { properties: { name: { type: "keyword", ignore_above: 256 }, value: { type: "double" } } } },
      }),
    });
    const text = await runCli(["mapping", "--format", "json"], client);
    const rows: readonly Record<string, unknown>[] = JSON.parse(text);
    expect(rows).toContainEqual({ FIELD: "name", TYPE: "keyword", IGNORE_ABOVE: 256 });
    expect(rows).toContainEqual({ FIELD: "value", TYPE: "double", IGNORE_ABOVE: "" });
  });

  it("fails clearly for an unknown --field", async () => {
    const client = fakeClient({ getMapping: async () => ({ idx: { mappings: { properties: {} } } }) });
    await expect(runCli(["mapping", "--field", "nope"], client)).rejects.toThrow(/was not found in the mapping/);
  });

  it("defaults --index to metrics-*", async () => {
    let capturedIndex = "";
    const client = fakeClient({
      getMapping: async (index) => {
        capturedIndex = index;
        return { idx: { mappings: { properties: {} } } };
      },
    });
    await runCli(["mapping"], client);
    expect(capturedIndex).toBe("metrics-*");
  });

  it("reports the implicit object type for a field with nested properties but no explicit type", async () => {
    // Real OpenSearch/Elasticsearch mappings never write an explicit "type": "object" —
    // it's only ever implicit from the presence of a nested `properties` block.
    // Confirmed live for `instrumentationScope` on real metric documents.
    const client = fakeClient({
      getMapping: async () => ({
        idx: { mappings: { properties: { instrumentationScope: { properties: { name: { type: "keyword" } } } } } },
      }),
    });
    const text = await runCli(["mapping", "--field", "instrumentationScope", "--format", "json"], client);
    expect(JSON.parse(text)).toEqual([{ FIELD: "instrumentationScope", TYPE: "object", IGNORE_ABOVE: "" }]);
  });

  it("still reports an explicit nested type as nested, not object", async () => {
    const client = fakeClient({
      getMapping: async () => ({
        idx: { mappings: { properties: { exemplars: { type: "nested", properties: { value: { type: "double" } } } } } },
      }),
    });
    const text = await runCli(["mapping", "--field", "exemplars", "--format", "json"], client);
    expect(JSON.parse(text)).toEqual([{ FIELD: "exemplars", TYPE: "nested", IGNORE_ABOVE: "" }]);
  });
});

describe("fields", () => {
  it("lists every flat attribute key on a sample metric document", async () => {
    const client = fakeClient({
      search: async () => ({
        totalHits: 1,
        hits: [hit("1", { name: "container.cpu.usage", kind: "GAUGE", "resource.attributes.sap@cf@app_name": "app" })],
      }),
    });
    const text = await runCli(["fields", "--format", "json"], client);
    expect(text).toContain("3 flat attribute keys found");
    expect(JSON.parse(text.split("\n").slice(1).join("\n"))).toEqual([
      { KEY: "kind" },
      { KEY: "name" },
      { KEY: "resource.attributes.sap@cf@app_name" },
    ]);
  });

  it("fails clearly when no document matches", async () => {
    const client = fakeClient({ search: async () => ({ totalHits: 0, hits: [] }) });
    await expect(runCli(["fields"], client)).rejects.toThrow(/No matching metric document/);
  });
});

describe("names", () => {
  it("lists metric names with kind/unit/doc_count", async () => {
    const client = fakeClient({
      search: async () => ({
        totalHits: 0,
        hits: [],
        aggregations: {
          by_name: {
            buckets: [
              { key: "container.cpu.usage", doc_count: 208, by_kind: { buckets: [{ key: "GAUGE" }] }, by_unit: { buckets: [{ key: "1" }] } },
            ],
          },
        },
      }),
    });
    const text = await runCli(["names", "--service", "app", "--format", "json"], client);
    expect(JSON.parse(text)).toEqual([{ NAME: "container.cpu.usage", KIND: "GAUGE", UNIT: "1", DOC_COUNT: 208 }]);
  });

  it("requires --service", async () => {
    const client = fakeClient();
    await expect(runCli(["names"], client)).rejects.toThrow();
  });

  it("rejects a --since that is neither a relative duration nor an ISO-8601 timestamp before contacting the client", async () => {
    const client = fakeClient();
    await expect(runCli(["names", "--service", "app", "--since", "not-a-time"], client)).rejects.toThrow(
      /Invalid --since value "not-a-time"/,
    );
    expect(clientBootstrap.withOpenSearchClient).not.toHaveBeenCalled();
  });
});

describe("history", () => {
  it("auto-resolves kind then renders GAUGE buckets", async () => {
    let call = 0;
    const client = fakeClient({
      search: async () => {
        call += 1;
        if (call === 1) {
          return { totalHits: 0, hits: [], aggregations: { by_kind: { buckets: [{ key: "GAUGE" }] } } };
        }
        return {
          totalHits: 0,
          hits: [],
          aggregations: { over_time: { buckets: [{ key_as_string: "t1", doc_count: 5, avg_value: { value: 1 }, min_value: { value: 1 }, max_value: { value: 1 } }] } },
        };
      },
    });
    const text = await runCli(["history", "--service", "app", "--name", "container.cpu.usage", "--format", "json"], client);
    expect(JSON.parse(text)).toEqual([{ TIME: "t1", AVG: 1, MIN: 1, MAX: 1, DOC_COUNT: 5 }]);
  });

  it("skips kind auto-resolution when --kind is given explicitly", async () => {
    const search = vi.fn(async () => ({ totalHits: 0, hits: [], aggregations: { over_time: { buckets: [] } } }));
    const client: OpenSearchClient = { search, count: async () => 0, getMapping: async () => ({}) };
    await runCli(["history", "--service", "app", "--name", "container.cpu.usage", "--kind", "GAUGE", "--format", "json"], client);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("requires at least one --name", async () => {
    const client = fakeClient();
    await expect(runCli(["history", "--service", "app"], client)).rejects.toThrow(/At least one --name is required/);
  });

  it("prints a header per metric and a cumulative-temporality warning for SUM kind when applicable", async () => {
    const client = fakeClient({
      search: async (_index, body) => {
        if (body["size"] === 1) {
          return { totalHits: 1, hits: [hit("1", { aggregationTemporality: "AGGREGATION_TEMPORALITY_CUMULATIVE" })] };
        }
        return { totalHits: 0, hits: [], aggregations: { over_time: { buckets: [] } } };
      },
    });
    const text = await runCli(
      ["history", "--service", "app", "--name", "queue.incoming_messages", "--kind", "SUM", "--format", "json"],
      client,
    );
    expect(text).toContain("WARNING");
    expect(text).toContain("not delta-corrected");
  });
});

describe("snapshot", () => {
  it("renders the latest point per metric name", async () => {
    const client = fakeClient({
      search: async () => ({
        totalHits: 0,
        hits: [],
        aggregations: {
          by_name: {
            buckets: [{ key: "container.cpu.usage", latest: { hits: { hits: [{ _source: { kind: "GAUGE", value: 0.02, unit: "1", time: "t1" } }] } } }],
          },
        },
      }),
    });
    const text = await runCli(["snapshot", "--service", "app", "--format", "json"], client);
    expect(JSON.parse(text)).toEqual([{ NAME: "container.cpu.usage", KIND: "GAUGE", VALUE: 0.02, UNIT: "1", TIME: "t1" }]);
  });

  it("requires --service", async () => {
    const client = fakeClient();
    await expect(runCli(["snapshot"], client)).rejects.toThrow();
  });
});

describe("top", () => {
  it("ranks apps by avg value for one metric name, with no --service filter", async () => {
    const client = fakeClient({
      search: async () => ({
        totalHits: 0,
        hits: [],
        aggregations: { by_app: { buckets: [{ key: "app-a", doc_count: 10, avg_value: { value: 5 }, max_value: { value: 9 } }] } },
      }),
    });
    const text = await runCli(["top", "--name", "container.memory.usage", "--format", "json"], client);
    expect(JSON.parse(text)).toEqual([{ APP: "app-a", AVG: 5, MAX: 9, DOC_COUNT: 10 }]);
  });

  it("requires --name", async () => {
    const client = fakeClient();
    await expect(runCli(["top"], client)).rejects.toThrow();
  });
});

/**
 * `CLI_VERSION` is read from `package.json` at runtime (via `/core`),
 * so `--version` and the self-updater can never drift from the manifest the way
 * a hand-maintained constant did. This pins that the lookup finds the right
 * manifest from the source tree as well as from `dist/`.
 */
describe("CLI_VERSION", () => {
  it("matches the version in package.json", async () => {
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(CLI_VERSION).toBe(manifest.version);
  });
});
