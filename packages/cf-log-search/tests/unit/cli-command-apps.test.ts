import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerAppsCommand } from "../../src/cli/commands/apps.js";

interface SearchBody {
  readonly aggs?: { readonly by_app?: { readonly terms?: { readonly size?: number } } };
}

const searchMock = vi.fn(async (_index: string, _body: SearchBody) => ({
  totalHits: 0,
  hits: [],
  aggregations: { by_app: { buckets: [{ key: "acme-svc-config", doc_count: 1_292_806 }] } },
}));

vi.mock("../../src/cli/client-bootstrap.js", () => ({
  withOpenSearchClient: vi.fn(async (_opts: unknown, work: (client: unknown) => Promise<void>) => {
    await work({ search: searchMock });
  }),
}));

describe("apps command", () => {
  it("prints app names with their doc counts", async () => {
    const program = new Command();
    registerAppsCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "apps", "--format", "json"]);

    const printed = logSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(printed).toContain("acme-svc-config");
    expect(printed).toContain("1292806");
    logSpy.mockRestore();
  });

  it("--limit 0 requests every bucket instead of the default cap", async () => {
    const program = new Command();
    registerAppsCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    searchMock.mockClear();

    await program.parseAsync(["node", "cf-log-search", "apps", "--limit", "0", "--format", "json"]);

    const call = searchMock.mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.[1].aggs?.by_app?.terms?.size).toBe(10_000);
    logSpy.mockRestore();
  });
});
