import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerFieldsCommand } from "../../src/cli/commands/fields.js";

vi.mock("../../src/cli/client-bootstrap.js", () => ({
  withOpenSearchClient: vi.fn(async (_opts: unknown, work: (client: unknown) => Promise<void>) => {
    await work({
      getMapping: vi.fn(async () => ({
        "logs-cfsyslog-000053": { mappings: { properties: { level: { type: "text", fields: { keyword: { type: "keyword" } } }, response_status: { type: "integer" } } } },
      })),
    });
  }),
}));

describe("fields command", () => {
  it("defaults to the curated list with no network call", async () => {
    const program = new Command();
    registerFieldsCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { withOpenSearchClient } = await import("../../src/cli/client-bootstrap.js");

    await program.parseAsync(["node", "cf-log-search", "fields", "--format", "json"]);

    expect(withOpenSearchClient).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(printed).toContain("@timestamp");
    logSpy.mockRestore();
  });

  it("--raw requires --index and hits getMapping on exactly that index", async () => {
    const program = new Command();
    registerFieldsCommand(program);
    program.exitOverride();

    await expect(program.parseAsync(["node", "cf-log-search", "fields", "--raw"])).rejects.toThrow(/--raw requires --index/);
  });

  it("--raw --index <concrete> flattens the real mapping, including .keyword sub-fields", async () => {
    const program = new Command();
    registerFieldsCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "fields", "--raw", "--index", "logs-cfsyslog-000053", "--format", "json"]);

    const printed = logSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(printed).toContain("level.keyword");
    expect(printed).toContain("response_status");
    logSpy.mockRestore();
  });

  it("--raw rejects an --index value containing a wildcard, to prevent the 92,000-line response", async () => {
    const program = new Command();
    registerFieldsCommand(program);
    program.exitOverride();

    await expect(program.parseAsync(["node", "cf-log-search", "fields", "--raw", "--index", "logs-cfsyslog-*"])).rejects.toThrow(
      /must name one concrete index, not a wildcard pattern/,
    );
  });
});
