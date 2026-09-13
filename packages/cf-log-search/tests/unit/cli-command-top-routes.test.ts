import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerTopRoutesCommand } from "../../src/cli/commands/top-routes.js";

interface SearchBody {
  readonly aggs?: {
    readonly by_route?: {
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
    aggregations: { by_route: { buckets: [{ key: "/SystemConfigService/getBrokerConfig()", doc_count: 1_292_806 }] } },
  }),
);

vi.mock("../../src/cli/client-bootstrap.js", () => ({
  withOpenSearchClient: vi.fn(async (_opts: unknown, work: (client: unknown) => Promise<void>) => {
    await work({ search: searchMock });
  }),
}));

describe("top-routes command", () => {
  beforeEach(() => {
    searchMock.mockClear();
  });

  it("prints routes ranked by request count", async () => {
    const program = new Command();
    registerTopRoutesCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "top-routes", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(printed).toEqual([{ ROUTE: "/SystemConfigService/getBrokerConfig()", DOC_COUNT: 1_292_806 }]);
    logSpy.mockRestore();
  });

  it("queries the correct field 'request.keyword'", async () => {
    const program = new Command();
    registerTopRoutesCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "top-routes", "--format", "json"]);

    const call = searchMock.mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.[1].aggs?.by_route?.terms?.field).toBe("request.keyword");
    logSpy.mockRestore();
  });

  it("--limit reaches the query body", async () => {
    const program = new Command();
    registerTopRoutesCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "top-routes", "--limit", "5", "--format", "json"]);

    const call = searchMock.mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.[1].aggs?.by_route?.terms?.size).toBe(5);
    logSpy.mockRestore();
  });

  it("--app reaches the query body", async () => {
    const program = new Command();
    registerTopRoutesCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "top-routes", "--app", "my-app", "--format", "json"]);

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
});
