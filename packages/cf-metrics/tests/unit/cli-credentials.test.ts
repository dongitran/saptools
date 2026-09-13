import * as core from "@saptools/core";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerCredentialCommands } from "../../src/cli/credentials.js";

vi.mock("@saptools/core", async (importOriginal) => {
  const actual = await importOriginal<typeof core>();
  return { ...actual, listCachedCredentials: vi.fn(), clearCredentialCache: vi.fn() };
});

function buildTestProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerCredentialCommands(program);
  for (const command of program.commands) {
    command.exitOverride();
    for (const nested of command.commands) {
      nested.exitOverride();
    }
  }
  return program;
}

function captureStdout(): { text: () => string } {
  let buffer = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    buffer += String(chunk);
    return true;
  });
  return { text: () => buffer };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("credential list", () => {
  it("shows target, instance, source, endpoint and expiry for each cached credential", async () => {
    vi.mocked(core.listCachedCredentials).mockResolvedValue([
      {
        region: "eu10",
        org: "example-org",
        space: "space-demo",
        instance: "cloud-logging",
        source: "service-key:logging-key",
        dashboardsEndpoint: "https://dash.example.com",
        cachedAt: "2026-09-02T10:00:00.000Z",
        expiresAt: "2026-09-09T10:00:00.000Z",
      },
    ]);
    const output = captureStdout();

    await buildTestProgram().parseAsync(["node", "cf-metrics", "credential", "list", "--format", "json"]);

    expect(JSON.parse(output.text())).toEqual([
      {
        TARGET: "eu10/example-org/space-demo",
        INSTANCE: "cloud-logging",
        SOURCE: "service-key:logging-key",
        ENDPOINT: "https://dash.example.com",
        CACHED_AT: "2026-09-02T10:00:00.000Z",
        EXPIRES_AT: "2026-09-09T10:00:00.000Z",
      },
    ]);
  });

  it("renders a table by default and says so when nothing is cached", async () => {
    vi.mocked(core.listCachedCredentials).mockResolvedValue([]);
    const output = captureStdout();

    await buildTestProgram().parseAsync(["node", "cf-metrics", "credential", "list"]);

    expect(output.text().trim()).toBe("(no rows)");
  });
});

describe("credential clear", () => {
  it("reports how many credentials were removed", async () => {
    vi.mocked(core.clearCredentialCache).mockResolvedValue(2);
    const output = captureStdout();

    await buildTestProgram().parseAsync(["node", "cf-metrics", "credential", "clear"]);

    expect(output.text().trim()).toBe("removed=2");
  });
});
