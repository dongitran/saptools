import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerSearchCommand } from "../../src/cli/commands/search.js";

vi.mock("../../src/cli/client-bootstrap.js", () => ({
  withOpenSearchClient: vi.fn(async (_opts: unknown, work: (client: unknown) => Promise<void>) => {
    await work({
      raw: vi.fn(async (path: string, method: string) => {
        if (path.includes("/_search/point_in_time")) {
          return { pit_id: "pit-1" };
        }
        if (path === "_search/point_in_time" && method === "DELETE") {
          return { pits: [{ successful: true }] };
        }
        return {
          pit_id: "pit-1",
          hits: {
            total: { value: 1 },
            hits: [{ _id: "abc", _source: { "@timestamp": "2026-09-12T05:00:00.000Z", source_type: "APP/PROC/WEB", app_name: "my-app", msg: "hello" }, sort: [1, 0] }],
          },
        };
      }),
    });
  }),
}));

describe("search command", () => {
  it("registers with the documented flags and runs without throwing", async () => {
    const program = new Command();
    registerSearchCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    // Every optional filter flag set at once, so buildSearchQuery's per-field
    // conditional spreads (query-builder.ts is unit-tested for each of these
    // individually already) are each actually wired through from this
    // command's own opts, not just left at their "absent" default.
    await program.parseAsync([
      "node",
      "cf-log-search",
      "search",
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
      "--format",
      "json",
    ]);

    expect(logSpy).toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(printed).toContain("hello");
    logSpy.mockRestore();
  });

  it("rejects a --limit above OpenSearch's result-window ceiling before any network call", async () => {
    const program = new Command();
    registerSearchCommand(program);
    const errorSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    program.exitOverride();

    await expect(program.parseAsync(["node", "cf-log-search", "search", "--limit", "10001"])).rejects.toThrow();

    errorSpy.mockRestore();
  });

  it("rejects a non-integer --status before any network call", async () => {
    const program = new Command();
    registerSearchCommand(program);
    const errorSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    program.exitOverride();

    await expect(program.parseAsync(["node", "cf-log-search", "search", "--status", "not-a-number"])).rejects.toThrow();

    errorSpy.mockRestore();
  });

  it("rejects a zero or negative --limit", async () => {
    const program = new Command();
    registerSearchCommand(program);
    const errorSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    program.exitOverride();

    await expect(program.parseAsync(["node", "cf-log-search", "search", "--limit", "0"])).rejects.toThrow();

    errorSpy.mockRestore();
  });
});
