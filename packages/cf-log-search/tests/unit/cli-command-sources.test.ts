import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerSourcesCommand } from "../../src/cli/commands/sources.js";

vi.mock("../../src/cli/client-bootstrap.js", () => ({
  withOpenSearchClient: vi.fn(async (_opts: unknown, work: (client: unknown) => Promise<void>) => {
    await work({
      search: vi.fn(async () => ({
        totalHits: 0,
        hits: [],
        aggregations: { by_source: { buckets: [{ key: "APP/PROC/WEB", doc_count: 1_893_037 }, { key: "RTR", doc_count: 880_033 }] } },
      })),
    });
  }),
}));

describe("sources command", () => {
  it("prints source_type names with their doc counts", async () => {
    const program = new Command();
    registerSourcesCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "sources", "--format", "json"]);

    const printed = logSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(printed).toContain("APP/PROC/WEB");
    expect(printed).toContain("RTR");
    logSpy.mockRestore();
  });
});
