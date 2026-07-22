import { afterEach, describe, expect, it, vi } from "vitest";

import { formatOutput, writeOutput } from "../../src/cli/render.js";

const target = { region: "ap10", org: "org", space: "dev", app: "demo-app" } as const;
const meta = { target, process: "web", instance: 0, durationMs: 1, truncated: false } as const;

describe("CLI output rendering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes human-readable output to stdout without warning for complete results", () => {
    const writeStdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const writeStderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    writeOutput({ meta, roots: ["/workspace/app"] });

    expect(writeStdout).toHaveBeenCalledWith("/workspace/app\n");
    expect(writeStderr).not.toHaveBeenCalled();
  });

  it("warns on stderr while preserving human-readable stdout for incomplete results", () => {
    const writeStdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const writeStderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    writeOutput({
      meta: { ...meta, truncated: true },
      matches: [{ instance: 0, line: 2, path: "/workspace/app/src/connect.js" }],
    });

    expect(writeStdout).toHaveBeenCalledWith("#0\t/workspace/app/src/connect.js:2\n");
    expect(writeStderr).toHaveBeenCalledWith(
      "Warning: Results may be incomplete; increase --max-files, --max-matches, or --max-bytes and retry.\n",
    );
  });

  it("formats primitive and fallback human output", () => {
    expect(formatOutput("plain")).toBe("plain\n");
    expect(formatOutput({ unknown: true })).toBe("{\n  \"unknown\": true\n}\n");
  });

  it("renders discovery result shapes for human output", () => {
    expect(formatOutput({ meta, roots: ["/workspace/app"] })).toBe("/workspace/app\n");
    expect(formatOutput({ meta, roots: [] })).toBe("No roots discovered.\n");
    expect(formatOutput({
      meta,
      instances: [{ index: 0, state: "running", since: "today" }],
    })).toBe("#0\trunning\ttoday\n");
    expect(formatOutput({ meta, instances: [] })).toBe("No instances reported.\n");
    expect(formatOutput({ meta, instances: [null] }))
      .toBe(`${JSON.stringify({ meta, instances: [null] }, null, 2)}\n`);
    expect(formatOutput({
      meta,
      path: "/workspace/app",
      entries: [{ instance: 0, kind: "directory", name: "src", path: "/workspace/app/src" }],
    })).toBe("#0\t[directory]\tsrc\t/workspace/app/src\n");
    expect(formatOutput({
      meta,
      path: "/workspace/app/node_modules/@scope",
      entries: [{
        instance: 0,
        kind: "symlink",
        name: "pkg",
        path: "/workspace/app/node_modules/@scope/pkg",
        target: "../.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg",
      }],
    })).toBe(
      "#0\t[symlink]\tpkg\t/workspace/app/node_modules/@scope/pkg\t-> ../.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg\n",
    );
    expect(formatOutput({ meta, path: "/workspace/app", entries: [] })).toBe("No entries.\n");
  });

  it("renders matches and view output for human output", () => {
    expect(formatOutput({
      meta,
      matches: [{ instance: 0, kind: "file", path: "/workspace/app/src/connect.js" }],
    })).toBe("#0\t/workspace/app/src/connect.js[file]\n");
    expect(formatOutput({
      meta,
      matches: [{ instance: 0, line: 2, path: "/workspace/app/src/connect.js", preview: "needle" }],
    })).toBe("#0\t/workspace/app/src/connect.js:2\tneedle\n");
    expect(formatOutput({ meta, matches: [] })).toBe("No matches.\n");
    expect(formatOutput({
      meta,
      file: "/workspace/app/src/connect.js",
      lines: [{ line: 2, text: "needle" }],
    })).toBe("# /workspace/app/src/connect.js\n    2  needle\n");
  });

  it("renders inspect, lifecycle, and session outputs for human output", () => {
    expect(formatOutput({
      meta,
      roots: ["/workspace/app"],
      files: [],
      contentMatches: [{ path: "/workspace/app/src/connect.js", line: 2 }],
      suggestedBreakpoints: [{ bp: "/workspace/app/src/connect.js", line: 2, confidence: "high" }],
    })).toContain("Suggested breakpoints:\n  [high] /workspace/app/src/connect.js:2");
    expect(formatOutput({
      meta,
      roots: [],
      files: [],
      contentMatches: [],
      suggestedBreakpoints: [],
    })).toBe("No candidates discovered.\n");
    expect(formatOutput({ changed: false, status: "enabled", message: "SSH is enabled." }))
      .toBe("enabled: SSH is enabled.\n");
    expect(formatOutput({ sessions: [] })).toBe("No persistent sessions.\n");
    expect(formatOutput({
      sessions: [{ sessionId: "session-a", status: "ready", target }],
    })).toBe("session-a\tready\tdemo-app\n");
    expect(formatOutput({
      sessions: [{ sessionId: "session-b", status: "ready" }],
    })).toBe("session-b\tready\t?\n");
    expect(formatOutput({ stopped: 2 })).toBe("stopped: 2\n");
    expect(formatOutput({
      sessionId: "session-a",
      status: "ready",
      brokerAlive: true,
      sshAlive: true,
      socketAlive: true,
    })).toContain("socketAlive: true");
    expect(formatOutput({
      sessionId: "session-a",
      status: "ready",
      brokerPid: 123,
      socketPath: "/tmp/session.sock",
    })).toContain("brokerPid: 123");
  });

  it("formats unusual session status cells without object stringification", () => {
    const output = formatOutput({
      sessionId: "session-a",
      status: "ready",
      brokerAlive: Symbol("unknown"),
      sshAlive: () => undefined,
      socketAlive: { ok: true },
    });

    expect(output).toContain("brokerAlive: unknown");
    expect(output).toContain("sshAlive: ");
    expect(output).toContain("socketAlive: {\"ok\":true}");

    const emptyCells = formatOutput({
      sessionId: "session-b",
      status: "ready",
      brokerAlive: undefined,
      sshAlive: null,
      socketAlive: true,
    });
    expect(emptyCells).toContain("brokerAlive: ");
    expect(emptyCells).toContain("sshAlive: ");
  });
});
