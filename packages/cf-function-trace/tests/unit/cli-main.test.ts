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

  it("turns Commander parse failures into exit code two", async () => {
    const errorOutput: string[] = [];
    const exitCode = await runCli([
      "node", "cf-function-trace", "unknown-command",
    ], {
      stdout: collectingStream([]),
      stderr: collectingStream(errorOutput),
      handlers: handlers(vi.fn(async (): Promise<void> => undefined)),
    });
    expect(exitCode).toBe(2);
    expect(errorOutput.join("")).toContain("COMMAND_USAGE");
  });
});
