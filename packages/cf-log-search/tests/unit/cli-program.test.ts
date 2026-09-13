import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as core from "@saptools/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/program.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cf-log-search-program-test-"));
  process.env["CF_LOG_SEARCH_SAPTOOLS_ROOT"] = root;
  vi.spyOn(core, "assertResultStoreWritable");
});

afterEach(() => {
  delete process.env["CF_LOG_SEARCH_SAPTOOLS_ROOT"];
  rmSync(root, { recursive: true, force: true });
});

describe("buildProgram", () => {
  it("registers every command this phase ships", () => {
    const program = buildProgram();
    const names = program.commands.map((command) => command.name());
    expect(names).toEqual(expect.arrayContaining(["search", "count", "fields", "apps", "sources", "result", "credential", "self-update"]));
  });

  it("reports the version read from package.json", () => {
    const program = buildProgram();
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("checks the saved-result store is writable before a --save command's action runs", async () => {
    const program = buildProgram();
    // `fields --save` (no --raw) never touches the OpenSearch client — the
    // curated reference path — so this exercises the real preAction hook
    // through a real command invocation with nothing else to mock.
    await program.parseAsync(["node", "cf-log-search", "fields", "--save"]);
    expect(core.assertResultStoreWritable).toHaveBeenCalledTimes(1);
    expect(core.assertResultStoreWritable).toHaveBeenCalledWith(expect.objectContaining({ cliName: "cf-log-search" }));
  });

  it("does not check the result store for a command with no --save flag", async () => {
    const program = buildProgram();
    await program.parseAsync(["node", "cf-log-search", "fields"]);
    expect(core.assertResultStoreWritable).not.toHaveBeenCalled();
  });
});
