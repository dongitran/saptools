import { afterEach, describe, expect, it, vi } from "vitest";

import { writeHumanSnapshot, writeJson, writeLogEvent } from "../../src/cli/output.js";
import type { LogpointEvent } from "../../src/logpoint/events.js";
import type { SnapshotResult } from "../../src/types.js";

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
});
