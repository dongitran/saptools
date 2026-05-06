import { afterEach, describe, expect, it, vi } from "vitest";

import { writeHumanSnapshot, writeJson, writeLogEvent, writeWatchEvent } from "../../src/cli/output.js";
import type { LogpointEvent } from "../../src/logpoint/events.js";
import type { SnapshotResult, WatchEvent } from "../../src/types.js";

const writeSpy = vi.spyOn(process.stdout, "write");

afterEach(() => {
  writeSpy.mockReset();
});

function captureStdout(fn: () => void): string {
  let output = "";
  writeSpy.mockImplementation((chunk: string | Uint8Array): boolean => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  });
  fn();
  return output;
}

describe("CLI output helpers", () => {
  it("writes formatted JSON with a trailing newline", () => {
    const output = captureStdout(() => {
      writeJson({ ok: true });
    });

    expect(output).toBe("{\n  \"ok\": true\n}\n");
  });

  it("writes a human snapshot without raw breakpoint identifiers", () => {
    const snapshot: SnapshotResult = {
      reason: "other",
      hitBreakpoints: ["verbose-url-regex-id"],
      capturedAt: "2026-01-01T00:00:00.000Z",
      pausedDurationMs: 12.345,
      topFrame: {
        functionName: "handler",
        url: "file:///app/src/handler.js",
        line: 42,
        column: 3,
        scopes: [
          {
            type: "local",
            variables: [{ name: "id", value: "7", type: "number" }],
          },
        ],
      },
      captures: [{ expression: "id", value: "7", type: "number" }],
    };

    const output = captureStdout(() => {
      writeHumanSnapshot(snapshot);
    });

    expect(output).toContain("Snapshot @ 2026-01-01T00:00:00.000Z");
    expect(output).toContain("paused:  12.3ms");
    expect(output).toContain("handler file:///app/src/handler.js:42:3");
    expect(output).toContain("scope local (1 vars):");
    expect(output).toContain("id = 7");
    expect(output).not.toContain("verbose-url-regex-id");
  });

  it("writes logpoint events as JSON Lines", () => {
    const event: LogpointEvent = {
      ts: "2026-01-01T00:00:00.000Z",
      at: "src/handler.ts:42",
      value: "ok",
    };

    const output = captureStdout(() => {
      writeLogEvent(event, true);
    });

    expect(JSON.parse(output) as LogpointEvent).toEqual(event);
    expect(output.endsWith("\n")).toBe(true);
  });

  it("writes human logpoint errors", () => {
    const output = captureStdout(() => {
      writeLogEvent({
        ts: "2026-01-01T00:00:00.000Z",
        at: "src/handler.ts:42",
        error: "missing value",
      }, false);
    });

    expect(output).toBe("[2026-01-01T00:00:00.000Z] src/handler.ts:42 !err missing value\n");
  });

  it("writes watch events as JSON Lines", () => {
    const event: WatchEvent = {
      ts: "2026-01-01T00:00:00.000Z",
      at: "file:///app/src/handler.js:42",
      hit: 3,
      reason: "other",
      hitBreakpoints: ["bp-1"],
      captures: [{ expression: "user.id", value: "7", type: "number" }],
    };
    const output = captureStdout(() => {
      writeWatchEvent(event, true);
    });
    expect(JSON.parse(output) as WatchEvent).toEqual(event);
    expect(output.endsWith("\n")).toBe(true);
  });

  it("writes human watch events with hit count and captures", () => {
    const event: WatchEvent = {
      ts: "2026-01-01T00:00:00.000Z",
      at: "file:///app/src/handler.js:42",
      hit: 2,
      reason: "other",
      hitBreakpoints: ["bp-1"],
      captures: [
        { expression: "user.id", value: "7" },
        { expression: "throwy", error: "ReferenceError" },
      ],
    };
    const output = captureStdout(() => {
      writeWatchEvent(event, false);
    });
    expect(output).toContain("hit#2");
    expect(output).toContain("user.id = 7");
    expect(output).toContain("throwy = ReferenceError");
  });

  it("renders the exception block in human snapshot output", () => {
    const snapshot: SnapshotResult = {
      reason: "exception",
      hitBreakpoints: [],
      capturedAt: "2026-01-01T00:00:00.000Z",
      pausedDurationMs: 5,
      exception: { value: "boom", description: "Error: boom" },
      topFrame: {
        functionName: "throwAt",
        url: "file:///app/src/handler.js",
        line: 7,
        column: 1,
      },
      captures: [],
    };
    const output = captureStdout(() => {
      writeHumanSnapshot(snapshot);
    });
    expect(output).toContain("exception: Error: boom");
  });

  it("renders the stack section in human snapshot output", () => {
    const snapshot: SnapshotResult = {
      reason: "other",
      hitBreakpoints: [],
      capturedAt: "2026-01-01T00:00:00.000Z",
      pausedDurationMs: 1,
      topFrame: {
        functionName: "deepest",
        url: "file:///app/a.js",
        line: 3,
        column: 1,
      },
      stack: [
        {
          functionName: "deepest",
          url: "file:///app/a.js",
          line: 3,
          column: 1,
          captures: [{ expression: "x", value: "1" }],
        },
        {
          functionName: "outer",
          url: "file:///app/a.js",
          line: 9,
          column: 1,
        },
      ],
      captures: [],
    };
    const output = captureStdout(() => {
      writeHumanSnapshot(snapshot);
    });
    expect(output).toContain("stack:");
    expect(output).toContain("deepest");
    expect(output).toContain("outer");
    expect(output).toContain("x = 1");
  });
});
