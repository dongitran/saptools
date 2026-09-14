import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerErrorsCommand } from "../../src/cli/commands/errors.js";

interface SearchBody {
  readonly aggs?: {
    readonly by_app?: {
      readonly terms?: { readonly size?: number };
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
      by_app: {
        buckets: [
          { key: "acme-svc-config", doc_count: 12, by_status: { buckets: [{ key: 500, doc_count: 9 }, { key: 404, doc_count: 3 }] } },
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

describe("errors command", () => {
  beforeEach(() => {
    searchMock.mockClear();
  });

  it("prints a flattened app x status_code x doc_count breakdown", async () => {
    const program = new Command();
    registerErrorsCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "errors", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(printed).toEqual(
      expect.arrayContaining([
        { APP: "acme-svc-config", STATUS: "500", DOC_COUNT: 9 },
        { APP: "acme-svc-config", STATUS: "404", DOC_COUNT: 3 },
      ]),
    );
    logSpy.mockRestore();
  });

  it("--app and --limit reach the query body", async () => {
    const program = new Command();
    registerErrorsCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "errors", "--app", "my-app", "--limit", "5", "--format", "json"]);

    const call = searchMock.mock.calls[0];
    expect(call).toBeDefined();
    expect(
      call?.[1].query?.bool?.filter?.some((clause) => {
        const term = (clause as { term?: { "app_name.keyword"?: string } }).term;
        return term?.["app_name.keyword"] === "my-app";
      }),
    ).toBe(true);
    expect(call?.[1].aggs?.by_app?.terms?.size).toBe(5);
    logSpy.mockRestore();
  });

  it("--limit 0 requests every bucket", async () => {
    const program = new Command();
    registerErrorsCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "errors", "--limit", "0", "--format", "json"]);

    const call = searchMock.mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.[1].aggs?.by_app?.terms?.size).toBe(10_000);
    logSpy.mockRestore();
  });

  it("handles empty aggregations", async () => {
    searchMock.mockImplementationOnce(async (): Promise<{ totalHits: number; hits: never[]; aggregations: Record<string, unknown> | undefined }> => ({
      totalHits: 0,
      hits: [],
      aggregations: {},
    }));

    const program = new Command();
    registerErrorsCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "errors", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(printed).toEqual([]);
    logSpy.mockRestore();
  });

  it("handles null aggregations", async () => {
    searchMock.mockImplementationOnce(async (): Promise<{ totalHits: number; hits: never[]; aggregations: Record<string, unknown> | undefined }> => ({
      totalHits: 0,
      hits: [],
      aggregations: undefined,
    }));

    const program = new Command();
    registerErrorsCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "errors", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(printed).toEqual([]);
    logSpy.mockRestore();
  });

  it("filters out buckets with missing or invalid fields", async () => {
    searchMock.mockImplementationOnce(async (): Promise<{ totalHits: number; hits: never[]; aggregations: Record<string, unknown> | undefined }> => ({
      totalHits: 0,
      hits: [],
      aggregations: {
        by_app: {
          buckets: [
            { key: "app1", doc_count: 10, by_status: { buckets: [{ key: 500, doc_count: 5 }] } },
            { doc_count: 10, by_status: { buckets: [] } },
            { key: 123, doc_count: 10, by_status: { buckets: [] } },
            { key: "app2", by_status: "not an object" },
          ],
        },
      },
    }));

    const program = new Command();
    registerErrorsCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "errors", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(printed).toEqual([{ APP: "app1", STATUS: "500", DOC_COUNT: 5 }]);
    logSpy.mockRestore();
  });
});
