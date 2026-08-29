import { afterEach, describe, expect, it, vi } from "vitest";

import { emitRows, parseFormat, parseIntOption, parseTraceIds, print, printNotice } from "../../src/cli/output.js";
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

describe("parseIntOption", () => {
  it("parses a valid integer", () => {
    expect(parseIntOption("42")).toBe(42);
  });

  it("throws on a non-integer", () => {
    expect(() => parseIntOption("4.5")).toThrow(/Expected an integer/);
    expect(() => parseIntOption("abc")).toThrow(/Expected an integer/);
  });
});

describe("parseTraceIds", () => {
  it("splits and trims a comma-separated list", () => {
    expect(parseTraceIds("a, b ,c")).toEqual(["a", "b", "c"]);
  });

  it("returns undefined for undefined input", () => {
    expect(parseTraceIds(undefined)).toBeUndefined();
  });

  it("returns undefined for an all-blank input", () => {
    expect(parseTraceIds(" , ,")).toBeUndefined();
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
    expect(spy).toHaveBeenCalledWith("cf-otel: careful\n");
    spy.mockRestore();
  });
});

describe("emitRows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints formatted rows to stdout when save is false", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await emitRows({ command: "find", rows: [{ NAME: "GET" }], format: "json", save: false });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('"NAME": "GET"'));
  });

  it("saves rows (never touching the real filesystem here) and prints ref=... when save is true", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const createSpy = vi.spyOn(resultStore, "createResultSession").mockResolvedValue({
      version: 1,
      ref: "deadbeef",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-08T00:00:00.000Z",
      ttlMinutes: 10_080,
      command: "find",
      rows: [{ NAME: "GET" }],
    });

    await emitRows({ command: "find", rows: [{ NAME: "GET" }], format: "table", save: true });

    expect(createSpy).toHaveBeenCalledWith({ command: "find", rows: [{ NAME: "GET" }] }, {});
    expect(stdoutSpy).toHaveBeenCalledWith("ref=deadbeef\n");
  });
});
