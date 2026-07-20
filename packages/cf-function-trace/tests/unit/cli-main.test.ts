import { Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/main.js";
import type { CliCommandHandlers } from "../../src/cli/program.js";
import { TraceDataError } from "../../src/errors.js";

function collectingStream(chunks: string[]): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback): void {
      chunks.push(chunk.toString());
      callback();
    },
  });
}

function handlers(plan: CliCommandHandlers["plan"]): CliCommandHandlers {
  return {
    plan,
    record: vi.fn(async (): Promise<void> => undefined),
    show: vi.fn(async (): Promise<void> => undefined),
    state: vi.fn(async (): Promise<void> => undefined),
    diff: vi.fn(async (): Promise<void> => undefined),
    runs: vi.fn(async (): Promise<void> => undefined),
    purge: vi.fn(async (): Promise<void> => undefined),
  };
}

describe("CLI main boundary", () => {
  it("runs a command without terminating the host process", async () => {
    const output: string[] = [];
    const errorOutput: string[] = [];
    const plan = vi.fn(async (): Promise<void> => undefined);

    const exitCode = await runCli([
      "node",
      "cf-function-trace",
      "plan",
      "dist/order.js",
      "create",
      "--port",
      "9229",
    ], {
      stdout: collectingStream(output),
      stderr: collectingStream(errorOutput),
      handlers: handlers(plan),
    });

    expect(exitCode).toBe(0);
    expect(plan).toHaveBeenCalledOnce();
    expect(errorOutput).toEqual([]);
  });

  it("returns structured usage errors without a stack trace", async () => {
    const errorOutput: string[] = [];
    const plan = vi.fn(async (): Promise<never> => {
      throw new TraceDataError("INVALID_ARGUMENT", "The selected option is invalid.");
    });

    const exitCode = await runCli([
      "node",
      "cf-function-trace",
      "plan",
      "dist/order.js",
      "create",
      "--port",
      "9229",
    ], {
      stdout: collectingStream([]),
      stderr: collectingStream(errorOutput),
      handlers: handlers(plan),
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(errorOutput.join(""))).toEqual({
      error: { code: "INVALID_ARGUMENT", message: "The selected option is invalid." },
    });
    expect(errorOutput.join("")).not.toContain("stack");
  });

  it("does not expose unknown internal errors and maps aborts to exit 130", async () => {
    const unknownOutput: string[] = [];
    const unknownPlan = vi.fn(async (): Promise<never> => {
      throw new Error("database-password-sentinel");
    });
    const unknownCode = await runCli([
      "node", "cf-function-trace", "plan", "dist/order.js", "create", "--port", "9229",
    ], {
      stdout: collectingStream([]),
      stderr: collectingStream(unknownOutput),
      handlers: handlers(unknownPlan),
    });
    expect(unknownCode).toBe(1);
    expect(unknownOutput.join("")).not.toContain("database-password-sentinel");

    const abortOutput: string[] = [];
    const abortPlan = vi.fn(async (): Promise<never> => {
      throw new TraceDataError("TRACE_ABORTED", "Tracing was cancelled.");
    });
    const abortCode = await runCli([
      "node", "cf-function-trace", "plan", "dist/order.js", "create", "--port", "9229",
    ], {
      stdout: collectingStream([]),
      stderr: collectingStream(abortOutput),
      handlers: handlers(abortPlan),
    });
    expect(abortCode).toBe(130);
  });

  it("turns Commander parse failures into exit code two and surfaces Commander's own detail", async () => {
    const errorOutput: string[] = [];
    const exitCode = await runCli([
      "node", "cf-function-trace", "unknown-command",
    ], {
      stdout: collectingStream([]),
      stderr: collectingStream(errorOutput),
      handlers: handlers(vi.fn(async (): Promise<void> => undefined)),
    });
    expect(exitCode).toBe(2);
    const parsed: unknown = JSON.parse(errorOutput.join(""));
    expect(parsed).toMatchObject({
      error: { code: "commander.unknownCommand", message: expect.stringContaining("unknown-command") as unknown },
    });
  });

  // P0-1 regression: before the fix, Commander's per-subcommand
  // copyInheritedSettings snapshot pre-dated this file's own
  // exitOverride()/configureOutput() calls, so a parse failure on a
  // SUBCOMMAND (not the top-level program) fell straight into Commander's
  // raw process.exit() -- exit 1, zero bytes on stdout AND stderr, bypassing
  // the JSON-error contract entirely.
  it("surfaces a structured, non-empty error for a missing required subcommand option", async () => {
    const stdoutChunks: string[] = [];
    const errorOutput: string[] = [];
    const exitCode = await runCli([
      "node", "cf-function-trace", "state", "t0123456789abcdef",
    ], {
      stdout: collectingStream(stdoutChunks),
      stderr: collectingStream(errorOutput),
      handlers: handlers(vi.fn(async (): Promise<void> => undefined)),
    });
    expect(stdoutChunks.join("")).toBe("");
    expect(errorOutput.length).toBeGreaterThan(0);
    expect(exitCode).not.toBe(0);
    const parsed: unknown = JSON.parse(errorOutput.join(""));
    expect(parsed).toMatchObject({ error: { code: "commander.missingMandatoryOptionValue" } });
  });

  it("surfaces a structured, non-empty error for an unknown flag on record", async () => {
    const errorOutput: string[] = [];
    const exitCode = await runCli([
      "node", "cf-function-trace", "record", "dist/order.js", "create", "--bogus-flag",
    ], {
      stdout: collectingStream([]),
      stderr: collectingStream(errorOutput),
      handlers: handlers(vi.fn(async (): Promise<void> => undefined)),
    });
    expect(errorOutput.length).toBeGreaterThan(0);
    expect(exitCode).not.toBe(0);
    const parsed: unknown = JSON.parse(errorOutput.join(""));
    expect(parsed).toMatchObject({
      error: { code: "commander.unknownOption", message: expect.stringContaining("--bogus-flag") as unknown },
    });
  });

  it("surfaces AMBIGUOUS_FUNCTION candidates instead of discarding them", async () => {
    const errorOutput: string[] = [];
    const candidates = [
      { selector: "OrderService.create", url: "file:///app.js", startLine: 10 },
      { selector: "OrderService.create", url: "file:///app.js", startLine: 40 },
    ];
    const plan = vi.fn(async (): Promise<never> => {
      throw new TraceDataError("AMBIGUOUS_FUNCTION", "Function create is ambiguous.", candidates);
    });
    const exitCode = await runCli([
      "node", "cf-function-trace", "plan", "dist/order.js", "create", "--port", "9229",
    ], {
      stdout: collectingStream([]),
      stderr: collectingStream(errorOutput),
      handlers: handlers(plan),
    });
    expect(exitCode).toBe(2);
    const parsed: unknown = JSON.parse(errorOutput.join(""));
    expect(parsed).toMatchObject({ error: { code: "AMBIGUOUS_FUNCTION", candidates } });
  });

  it("shows help on bare invocation without also emitting a JSON error", async () => {
    const stdoutChunks: string[] = [];
    const errorOutput: string[] = [];
    const exitCode = await runCli([
      "node", "cf-function-trace",
    ], {
      stdout: collectingStream(stdoutChunks),
      stderr: collectingStream(errorOutput),
      handlers: handlers(vi.fn(async (): Promise<void> => undefined)),
    });
    expect(errorOutput.join("")).toBe("");
    expect(stdoutChunks.join("")).toContain("cf-function-trace");
    expect(stdoutChunks.join("")).toContain("record");
    expect(exitCode).toBe(1);
  });

  it("shows help for the bare help subcommand without also emitting a JSON error", async () => {
    const stdoutChunks: string[] = [];
    const errorOutput: string[] = [];
    const exitCode = await runCli([
      "node", "cf-function-trace", "help",
    ], {
      stdout: collectingStream(stdoutChunks),
      stderr: collectingStream(errorOutput),
      handlers: handlers(vi.fn(async (): Promise<void> => undefined)),
    });
    expect(exitCode).toBe(0);
    expect(errorOutput.join("")).toBe("");
    expect(stdoutChunks.join("")).toContain("record");
  });

  it("surfaces a recognized operational error's own code and message instead of a generic COMMAND_FAILED", async () => {
    const errorOutput: string[] = [];
    class FakeCfDebuggerError extends Error {
      public readonly code = "SESSION_ALREADY_RUNNING";

      public constructor() {
        super("A debugger session is already running for app orders. Stop it first with `cf-debugger stop`.");
        this.name = "CfDebuggerError";
      }
    }
    const record = vi.fn(async (): Promise<never> => {
      throw new FakeCfDebuggerError();
    });
    const testHandlers: CliCommandHandlers = { ...handlers(vi.fn(async (): Promise<void> => undefined)), record };
    const exitCode = await runCli([
      "node", "cf-function-trace", "record", "dist/order.js", "create", "--port", "9229",
    ], {
      stdout: collectingStream([]),
      stderr: collectingStream(errorOutput),
      handlers: testHandlers,
    });
    expect(exitCode).toBe(2);
    const parsed: unknown = JSON.parse(errorOutput.join(""));
    expect(parsed).toMatchObject({
      error: {
        code: "SESSION_ALREADY_RUNNING",
        message: expect.stringContaining("cf-debugger stop") as unknown,
      },
    });
  });

  it("surfaces a recoverable partial run's id and directory when attached to the thrown error", async () => {
    const errorOutput: string[] = [];
    const record = vi.fn(async (): Promise<never> => {
      const error = new TraceDataError("MAX_PAUSED_TIME", "Cumulative pause budget exceeded.");
      Reflect.set(error, "runId", "t0123456789abcdef");
      Reflect.set(error, "directory", "/home/user/.saptools/cf-function-trace/data/t0123456789abcdef");
      throw error;
    });
    const testHandlers: CliCommandHandlers = { ...handlers(vi.fn(async (): Promise<void> => undefined)), record };
    const exitCode = await runCli([
      "node", "cf-function-trace", "record", "dist/order.js", "create", "--port", "9229",
    ], {
      stdout: collectingStream([]),
      stderr: collectingStream(errorOutput),
      handlers: testHandlers,
    });
    expect(exitCode).toBe(2);
    const parsed: unknown = JSON.parse(errorOutput.join(""));
    expect(parsed).toMatchObject({
      error: {
        code: "MAX_PAUSED_TIME",
        runId: "t0123456789abcdef",
        directory: "/home/user/.saptools/cf-function-trace/data/t0123456789abcdef",
      },
    });
  });
});
