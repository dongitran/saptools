import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerLatencyCommand } from "../../src/cli/commands/latency.js";

let mockSearchResult: unknown = {
  totalHits: 0,
  hits: [],
  aggregations: {
    by_bucket: {
      buckets: [
        { key: "acme-svc-config", doc_count: 500, latency_percentiles: { values: { "50.0": 12.5, "95.0": 88.2, "99.0": 210.7 } } },
      ],
    },
  },
};

vi.mock("../../src/cli/client-bootstrap.js", () => ({
  withOpenSearchClient: vi.fn(async (_opts: unknown, work: (client: unknown) => Promise<void>) => {
    await work({
      search: vi.fn(async () => mockSearchResult),
    });
  }),
}));

describe("latency command", () => {
  beforeEach(() => {
    mockSearchResult = {
      totalHits: 0,
      hits: [],
      aggregations: {
        by_bucket: {
          buckets: [
            { key: "acme-svc-config", doc_count: 500, latency_percentiles: { values: { "50.0": 12.5, "95.0": 88.2, "99.0": 210.7 } } },
          ],
        },
      },
    };
  });

  it("prints p50/p95/p99 per bucket", async () => {
    const program = new Command();
    registerLatencyCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "latency", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(printed).toEqual([{ BUCKET: "acme-svc-config", P50_MS: 12.5, P95_MS: 88.2, P99_MS: 210.7, DOC_COUNT: 500 }]);
    logSpy.mockRestore();
  });

  it("rejects an unknown --by value before any network call", async () => {
    const program = new Command();
    registerLatencyCommand(program);
    program.exitOverride();

    await expect(program.parseAsync(["node", "cf-log-search", "latency", "--by", "nonsense"])).rejects.toThrow(/--by must be "app" or "route"/);
  });

  it("handles empty aggregations", async () => {
    mockSearchResult = { totalHits: 0, hits: [], aggregations: {} };

    const program = new Command();
    registerLatencyCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "latency", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(printed).toEqual([]);
    logSpy.mockRestore();
  });

  it("handles missing percentile values", async () => {
    mockSearchResult = {
      totalHits: 0,
      hits: [],
      aggregations: {
        by_bucket: {
          buckets: [
            { key: "app1", doc_count: 100, latency_percentiles: { values: { "50.0": 10.0 } } },
            { key: "app2", doc_count: 50 },
            { key: "app3", doc_count: 75, latency_percentiles: { values: {} } },
          ],
        },
      },
    };

    const program = new Command();
    registerLatencyCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "latency", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(printed).toEqual([
      { BUCKET: "app1", P50_MS: 10.0, P95_MS: null, P99_MS: null, DOC_COUNT: 100 },
      { BUCKET: "app2", P50_MS: null, P95_MS: null, P99_MS: null, DOC_COUNT: 50 },
      { BUCKET: "app3", P50_MS: null, P95_MS: null, P99_MS: null, DOC_COUNT: 75 },
    ]);
    logSpy.mockRestore();
  });

  it("respects --by route option", async () => {
    const program = new Command();
    registerLatencyCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "latency", "--by", "route", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(Array.isArray(printed)).toBe(true);
    logSpy.mockRestore();
  });

  it("respects --limit option", async () => {
    const program = new Command();
    registerLatencyCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "latency", "--limit", "5", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(Array.isArray(printed)).toBe(true);
    logSpy.mockRestore();
  });

  it("respects --app option", async () => {
    const program = new Command();
    registerLatencyCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "latency", "--app", "myapp", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(Array.isArray(printed)).toBe(true);
    logSpy.mockRestore();
  });
});
