import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerLatencyCommand } from "../../src/cli/commands/latency.js";

interface SearchBody {
  readonly aggs?: {
    readonly by_bucket?: {
      readonly terms?: { readonly field?: string; readonly size?: number };
    };
  };
  readonly query?: { readonly bool?: { readonly filter?: readonly unknown[] } };
}

const searchMock = vi.fn(
  async (
    _index: string,
    _body: SearchBody,
  ): Promise<{ totalHits: number; hits: never[]; aggregations: Record<string, unknown> | undefined }> => ({
    totalHits: 0,
    hits: [],
    aggregations: {
      by_bucket: {
        buckets: [
          { key: "acme-svc-config", doc_count: 500, latency_percentiles: { values: { "50.0": 12.5, "95.0": 88.2, "99.0": 210.7 } } },
        ],
      },
    },
  }),
);

vi.mock("../../src/cli/client-bootstrap.js", () => ({
  withOpenSearchClient: vi.fn(async (_opts: unknown, work: (client: unknown) => Promise<void>) => {
    await work({ search: searchMock });
  }),
}));

describe("latency command", () => {
  beforeEach(() => {
    searchMock.mockClear();
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

  it("--by route switches aggregation field to 'request.keyword'", async () => {
    const program = new Command();
    registerLatencyCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "latency", "--by", "route", "--format", "json"]);

    const call = searchMock.mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.[1].aggs?.by_bucket?.terms?.field).toBe("request.keyword");
    logSpy.mockRestore();
  });

  it("--limit reaches the query body", async () => {
    const program = new Command();
    registerLatencyCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "latency", "--limit", "5", "--format", "json"]);

    const call = searchMock.mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.[1].aggs?.by_bucket?.terms?.size).toBe(5);
    logSpy.mockRestore();
  });

  it("--limit 0 requests every bucket", async () => {
    const program = new Command();
    registerLatencyCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "latency", "--limit", "0", "--format", "json"]);

    const call = searchMock.mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.[1].aggs?.by_bucket?.terms?.size).toBe(10_000);
    logSpy.mockRestore();
  });

  it("--app reaches the query body", async () => {
    const program = new Command();
    registerLatencyCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "latency", "--app", "my-app", "--format", "json"]);

    const call = searchMock.mock.calls[0];
    expect(call).toBeDefined();
    expect(
      call?.[1].query?.bool?.filter?.some((clause) => {
        const term = (clause as { term?: { "app_name.keyword"?: string } }).term;
        return term?.["app_name.keyword"] === "my-app";
      }),
    ).toBe(true);
    logSpy.mockRestore();
  });

  it("handles empty aggregations", async () => {
    searchMock.mockImplementationOnce(async (): Promise<{ totalHits: number; hits: never[]; aggregations: Record<string, unknown> | undefined }> => ({
      totalHits: 0,
      hits: [],
      aggregations: {},
    }));

    const program = new Command();
    registerLatencyCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "latency", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(printed).toEqual([]);
    logSpy.mockRestore();
  });

  it("handles missing percentile values", async () => {
    searchMock.mockImplementationOnce(async (): Promise<{ totalHits: number; hits: never[]; aggregations: Record<string, unknown> | undefined }> => ({
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
    }));

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
});
