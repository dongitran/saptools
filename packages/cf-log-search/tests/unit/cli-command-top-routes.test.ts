import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerTopRoutesCommand } from "../../src/cli/commands/top-routes.js";

vi.mock("../../src/cli/client-bootstrap.js", () => ({
  withOpenSearchClient: vi.fn(async (_opts: unknown, work: (client: unknown) => Promise<void>) => {
    await work({
      search: vi.fn(async () => ({
        totalHits: 0,
        hits: [],
        aggregations: { by_route: { buckets: [{ key: "/SystemConfigService/getBrokerConfig()", doc_count: 1_292_806 }] } },
      })),
    });
  }),
}));

describe("top-routes command", () => {
  it("prints routes ranked by request count", async () => {
    const program = new Command();
    registerTopRoutesCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "top-routes", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(printed).toEqual([{ ROUTE: "/SystemConfigService/getBrokerConfig()", DOC_COUNT: 1_292_806 }]);
    logSpy.mockRestore();
  });
});
