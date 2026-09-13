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

    // Every optional filter flag at once — see search.ts's equivalent test
    // for why (each of buildSearchQuery's conditional spreads exercised).
    await program.parseAsync([
      "node",
      "cf-log-search",
      "count",
      "--app",
      "my-app",
      "--log-space",
      "app",
      "--level",
      "error",
      "--source-type",
      "RTR",
      "--query",
      "connection refused",
      "--vcap-request-id",
      "11111111-1111-4111-8111-111111111111",
      "--correlation-id",
      "22222222-2222-4222-8222-222222222222",
      "--status",
      "500",
      "--since",
      "24h",
      "--until",
      "1h",
    ]);

    expect(logSpy).toHaveBeenCalledWith("42\n");
    logSpy.mockRestore();
  });

  it("rejects a non-integer --status before any network call", async () => {
    const program = new Command();
    registerCountCommand(program);
    const errorSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    program.exitOverride();

    await expect(program.parseAsync(["node", "cf-log-search", "count", "--status", "not-a-number"])).rejects.toThrow();

    errorSpy.mockRestore();
  });
});
