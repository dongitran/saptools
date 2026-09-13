import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCachedCredential } from "@saptools/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerCredentialCommands } from "../../src/cli/credentials.js";

let root: string;
const TARGET = { apiEndpoint: "e", region: "br10", org: "o", space: "s", selectorSource: "explicit" as const, regionConfirmed: true };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cf-log-search-credentials-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("credential commands", () => {
  it("list shows the target/instance/source/endpoint/expiry, never the username or password", async () => {
    await writeCachedCredential({ target: TARGET }, { dashboardsEndpoint: "https://dash.example.com", username: "secret-user", password: "secret-pw", source: "service-key:k", instance: "cloud-logging" }, { cliName: "cf-log-search", saptoolsRoot: root });
    process.env["CF_LOG_SEARCH_SAPTOOLS_ROOT"] = root;
    const program = new Command();
    registerCredentialCommands(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "credential", "list", "--format", "json"]);

    const printed = logSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(printed).toContain("br10/o/s");
    expect(printed).not.toContain("secret-user");
    expect(printed).not.toContain("secret-pw");
    delete process.env["CF_LOG_SEARCH_SAPTOOLS_ROOT"];
    logSpy.mockRestore();
  });

  it("clear reports how many live credentials it removed", async () => {
    await writeCachedCredential({ target: TARGET }, { dashboardsEndpoint: "e", username: "u", password: "p", source: "s", instance: "i" }, { cliName: "cf-log-search", saptoolsRoot: root });
    process.env["CF_LOG_SEARCH_SAPTOOLS_ROOT"] = root;
    const program = new Command();
    registerCredentialCommands(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "credential", "clear"]);

    expect(logSpy).toHaveBeenCalledWith("removed=1\n");
    delete process.env["CF_LOG_SEARCH_SAPTOOLS_ROOT"];
    logSpy.mockRestore();
  });
});
