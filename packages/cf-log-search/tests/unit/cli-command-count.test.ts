import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerCountCommand } from "../../src/cli/commands/count.js";

vi.mock("../../src/cli/client-bootstrap.js", () => ({
  withOpenSearchClient: vi.fn(async (_opts: unknown, work: (client: unknown) => Promise<void>) => {
    await work({ count: vi.fn(async () => 42) });
  }),
}));

describe("count command", () => {
  it("prints the count OpenSearch returned", async () => {
    const program = new Command();
    registerCountCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "count", "--app", "my-app"]);

    expect(logSpy).toHaveBeenCalledWith("42\n");
    logSpy.mockRestore();
  });
});
