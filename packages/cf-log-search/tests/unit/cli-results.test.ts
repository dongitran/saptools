import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createResultSession } from "@saptools/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerResultCommands } from "../../src/cli/results.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cf-log-search-results-test-"));
  process.env["CF_LOG_SEARCH_SAPTOOLS_ROOT"] = root;
});

afterEach(() => {
  delete process.env["CF_LOG_SEARCH_SAPTOOLS_ROOT"];
  rmSync(root, { recursive: true, force: true });
});

describe("result commands", () => {
  it("show prints a previously saved result's rows", async () => {
    const session = await createResultSession({ cliName: "cf-log-search", command: "search", rows: [{ A: 1 }] }, { saptoolsRoot: root });
    const program = new Command();
    registerResultCommands(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "result", "show", session.ref, "--format", "json"]);

    expect(logSpy.mock.calls.map((call) => String(call[0])).join("")).toContain('"A": 1');
    logSpy.mockRestore();
  });

  it("list shows saved results without their rows", async () => {
    await createResultSession({ cliName: "cf-log-search", command: "search", rows: [{ A: 1 }] }, { saptoolsRoot: root });
    const program = new Command();
    registerResultCommands(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "result", "list", "--format", "json"]);

    expect(logSpy.mock.calls.map((call) => String(call[0])).join("")).toContain('"COMMAND": "search"');
    logSpy.mockRestore();
  });

  it("clear reports how many results it removed", async () => {
    await createResultSession({ cliName: "cf-log-search", command: "search", rows: [] }, { saptoolsRoot: root });
    const program = new Command();
    registerResultCommands(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "result", "clear"]);

    expect(logSpy).toHaveBeenCalledWith("removed=1\n");
    logSpy.mockRestore();
  });
});
