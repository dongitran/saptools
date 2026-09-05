import { afterEach, describe, expect, it, vi } from "vitest";

import { collectRepeatable, emitRows, parseFormat, parseNonNegativeIntOption, parsePositiveIntOption, print, printNotice } from "../../src/cli/output.js";
import * as resultStore from "../../src/result-store.js";

describe("parseFormat", () => {
  it("defaults to table when no value is given", () => {
    expect(parseFormat(undefined)).toBe("table");
  });

  it("accepts every valid format", () => {
    expect(parseFormat("json")).toBe("json");
    expect(parseFormat("json-compact")).toBe("json-compact");
    expect(parseFormat("csv")).toBe("csv");
  });

  it("throws on an invalid format", () => {
    expect(() => parseFormat("yaml")).toThrow(/Invalid --format/);
  });
});

describe("parseNonNegativeIntOption", () => {
  it("parses zero and positive integers", () => {
    expect(parseNonNegativeIntOption("0")).toBe(0);
    expect(parseNonNegativeIntOption("42")).toBe(42);
  });

  it("throws on a negative integer", () => {
    expect(() => parseNonNegativeIntOption("-1")).toThrow(/non-negative/);
  });

  it("throws on a non-integer", () => {
    expect(() => parseNonNegativeIntOption("4.5")).toThrow(/Expected an integer/);
  });
});

describe("parsePositiveIntOption", () => {
  it("parses a positive integer", () => {
    expect(parsePositiveIntOption("15000")).toBe(15_000);
  });

  it("throws on zero", () => {
    expect(() => parsePositiveIntOption("0")).toThrow(/positive/);
  });

  it("throws on a negative integer", () => {
    expect(() => parsePositiveIntOption("-5")).toThrow(/positive/);
  });
});

describe("collectRepeatable", () => {
  it("appends each value to the accumulated array", () => {
    expect(collectRepeatable("b", collectRepeatable("a", []))).toEqual(["a", "b"]);
  });
});

describe("print/printNotice", () => {
  it("print writes to stdout with a trailing newline", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    print("hello");
    expect(spy).toHaveBeenCalledWith("hello\n");
    spy.mockRestore();
  });

  it("printNotice writes to stderr prefixed with the CLI name", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    printNotice("careful");
    expect(spy).toHaveBeenCalledWith("cf-metrics: careful\n");
    spy.mockRestore();
  });
});

describe("emitRows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints formatted rows to stdout when save is false", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await emitRows({ command: "names", rows: [{ NAME: "container.cpu.usage" }], format: "json", save: false });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('"NAME": "container.cpu.usage"'));
  });

  it("forwards the env-derived store root so a save can never land in the real ~/.saptools", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const createSpy = vi.spyOn(resultStore, "createResultSession").mockResolvedValue({
      version: 1,
      ref: "deadbeef",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-08T00:00:00.000Z",
      ttlMinutes: 10_080,
      command: "names",
      rows: [{ NAME: "container.cpu.usage" }],
    });

    await emitRows({ command: "names", rows: [{ NAME: "container.cpu.usage" }], format: "table", save: true });

    // Asserting the forwarded options, not a literal `{}`: passing the
    // env-derived root through is the contract that keeps a save inside
    // whatever CF_METRICS_SAPTOOLS_ROOT points at.
    expect(createSpy).toHaveBeenCalledWith(
      { command: "names", rows: [{ NAME: "container.cpu.usage" }] },
      resultStore.resultStoreOptionsFromEnv(),
    );
    expect(stdoutSpy).toHaveBeenCalledWith("ref=deadbeef\n");
  });

  /**
   * A store that cannot be written used to throw straight out of here, so the
   * rows were never printed either — a caching problem discarded the ~30s
   * credential round trip and the query result with it.
   */
  it("prints the rows anyway, with a non-zero exit code, when the save fails", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(resultStore, "createResultSession").mockRejectedValue(new Error("EACCES: permission denied"));
    const previousExitCode = process.exitCode;

    try {
      await emitRows({ command: "names", rows: [{ NAME: "container.cpu.usage" }], format: "json", save: true });

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('"NAME": "container.cpu.usage"'));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("--save failed"));
      // Not thrown, so the rows above are reached — but the run is still a
      // failure, so `ref=$(… --save)` cannot bind a table row and look fine.
      expect(process.exitCode).toBe(1);
      // The ref line must not be printed when there is no ref.
      expect(stdoutSpy).not.toHaveBeenCalledWith(expect.stringContaining("ref="));
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
