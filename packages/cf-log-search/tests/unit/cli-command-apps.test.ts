import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerAppsCommand } from "../../src/cli/commands/apps.js";

vi.mock("../../src/cli/client-bootstrap.js", () => ({
  withOpenSearchClient: vi.fn(async (_opts: unknown, work: (client: unknown) => Promise<void>) => {
    await work({
      search: vi.fn(async () => ({
        totalHits: 0,
        hits: [],
        aggregations: { by_app: { buckets: [{ key: "acme-svc-config", doc_count: 1_292_806 }] } },
      })),
    });
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
});
