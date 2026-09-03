import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerResultCommands } from "../../src/cli/results.js";
import * as resultStore from "../../src/result-store.js";

vi.mock("../../src/result-store.js", () => ({
  readResultSession: vi.fn(),
  listResultSessions: vi.fn(),
  pruneResultSessions: vi.fn(),
  clearResultSessions: vi.fn(),
  resultStoreOptionsFromEnv: vi.fn(() => ({})),
}));

function buildTestProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerResultCommands(program);
  for (const command of program.commands) {
    command.exitOverride();
    for (const nested of command.commands) {nested.exitOverride();}
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

function captureStderr(): { text: () => string } {
  let buffer = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    buffer += String(chunk);
    return true;
  });
  return { text: () => buffer };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("result show", () => {
  it("prints the saved rows in the requested format", async () => {
    vi.mocked(resultStore.readResultSession).mockResolvedValue({
      version: 1,
      ref: "deadbeef",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-08T00:00:00.000Z",
      ttlMinutes: 10_080,
      command: "find",
      rows: [{ NAME: "GET" }],
    });
    const output = captureStdout();
    await buildTestProgram().parseAsync(["node", "cf-otel", "result", "show", "deadbeef", "--format", "json"]);
    expect(JSON.parse(output.text())).toEqual([{ NAME: "GET" }]);
  });

  it("prints one row's full JSON when --row is given", async () => {
    vi.mocked(resultStore.readResultSession).mockResolvedValue({
      version: 1,
      ref: "deadbeef",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-08T00:00:00.000Z",
      ttlMinutes: 10_080,
      command: "find",
      rows: [{ NAME: "GET" }, { NAME: "POST" }],
    });
    const output = captureStdout();
    await buildTestProgram().parseAsync(["node", "cf-otel", "result", "show", "deadbeef", "--row", "2"]);
    expect(JSON.parse(output.text())).toEqual({ NAME: "POST" });
  });
});

describe("result list/prune/clear", () => {
  it("lists active refs as a table", async () => {
    vi.mocked(resultStore.listResultSessions).mockResolvedValue([
      { ref: "aaaa1111", command: "find", rowCount: 3, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-08T00:00:00.000Z" },
    ]);
    const output = captureStdout();
    await buildTestProgram().parseAsync(["node", "cf-otel", "result", "list"]);
    expect(output.text()).toContain("aaaa1111");
  });

  it("prints removed=N for prune", async () => {
    vi.mocked(resultStore.pruneResultSessions).mockResolvedValue({ removed: 2, failed: 0, retainedRefs: [] });
    const output = captureStdout();
    await buildTestProgram().parseAsync(["node", "cf-otel", "result", "prune"]);
    expect(output.text()).toBe("removed=2\n");
  });

  it("exits non-zero when a sweep could not delete something, so a script can tell", async () => {
    const original = process.exitCode;
    try {
      vi.mocked(resultStore.pruneResultSessions).mockResolvedValue({ removed: 0, failed: 2, retainedRefs: [] });
      captureStdout();
      captureStderr();

      await buildTestProgram().parseAsync(["node", "cf-otel", "result", "prune"]);

      expect(process.exitCode).toBe(1);
    } finally {
      // Restore explicitly: an exit code set inside a test outlives it, and
      // would otherwise mark the whole suite failed on a runner that honours it.
      process.exitCode = original;
    }
  });

  it("leaves the exit code alone on a clean sweep", async () => {
    const original = process.exitCode;
    vi.mocked(resultStore.pruneResultSessions).mockResolvedValue({ removed: 1, failed: 0, retainedRefs: [] });
    captureStdout();

    await buildTestProgram().parseAsync(["node", "cf-otel", "result", "prune"]);

    expect(process.exitCode).toBe(original);
  });

  it("keeps removed=N the only stdout line, reporting retained and failed counts on stderr", async () => {
    vi.mocked(resultStore.pruneResultSessions).mockResolvedValue({ removed: 1, failed: 3, retainedRefs: ["ref0", "ref1"] });
    const output = captureStdout();
    const notices = captureStderr();
    await buildTestProgram().parseAsync(["node", "cf-otel", "result", "prune"]);
    expect(output.text()).toBe("removed=1\n");
    expect(notices.text()).toContain("2 saved result(s) were left in place");
    // The refs must be named, not just counted.
    expect(notices.text()).toContain("ref0, ref1");
    expect(notices.text()).toContain("3 expired saved result(s) could not be deleted");
  });

  it("prints removed=N for clear", async () => {
    vi.mocked(resultStore.clearResultSessions).mockResolvedValue(5);
    const output = captureStdout();
    await buildTestProgram().parseAsync(["node", "cf-otel", "result", "clear"]);
    expect(output.text()).toBe("removed=5\n");
  });
});
