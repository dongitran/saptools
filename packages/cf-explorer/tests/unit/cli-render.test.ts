import { describe, expect, it } from "vitest";

import { formatOutput } from "../../src/cli-render.js";

const target = { region: "ap10", org: "org", space: "dev", app: "demo-app" } as const;
const meta = { target, process: "web", instance: 0, durationMs: 1, truncated: false } as const;

describe("CLI output rendering", () => {
  it("formats JSON output with a trailing newline", () => {
    expect(formatOutput({ ok: true })).toBe("{\n  \"ok\": true\n}\n");
  });

  it("formats primitive and fallback human output", () => {
    expect(formatOutput("plain", false)).toBe("plain\n");
    expect(formatOutput({ unknown: true }, false)).toBe("{\n  \"unknown\": true\n}\n");
  });

  it("renders discovery result shapes for human output", () => {
    expect(formatOutput({ meta, roots: ["/workspace/app"] }, false)).toBe("/workspace/app\n");
    expect(formatOutput({ meta, roots: [] }, false)).toBe("No roots discovered.\n");
    expect(formatOutput({
      meta,
      instances: [{ index: 0, state: "running", since: "today" }],
    }, false)).toBe("#0\trunning\ttoday\n");
    expect(formatOutput({ meta, instances: [] }, false)).toBe("No instances reported.\n");
    expect(formatOutput({
      meta,
      path: "/workspace/app",
      entries: [{ instance: 0, kind: "directory", name: "src", path: "/workspace/app/src" }],
    }, false)).toBe("#0\t[directory]\tsrc\t/workspace/app/src\n");
    expect(formatOutput({ meta, path: "/workspace/app", entries: [] }, false)).toBe("No entries.\n");
  });

  it("renders matches and view output for human output", () => {
    expect(formatOutput({
      meta,
      matches: [{ instance: 0, kind: "file", path: "/workspace/app/src/connect.js" }],
    }, false)).toBe("#0\t/workspace/app/src/connect.js[file]\n");
    expect(formatOutput({
      meta,
      matches: [{ instance: 0, line: 2, path: "/workspace/app/src/connect.js", preview: "needle" }],
    }, false)).toBe("#0\t/workspace/app/src/connect.js:2\tneedle\n");
    expect(formatOutput({ meta, matches: [] }, false)).toBe("No matches.\n");
    expect(formatOutput({
      meta,
      file: "/workspace/app/src/connect.js",
      lines: [{ line: 2, text: "needle" }],
    }, false)).toBe("# /workspace/app/src/connect.js\n    2  needle\n");
  });

  it("renders inspect, lifecycle, and session outputs for human output", () => {
    expect(formatOutput({
      meta,
      roots: ["/workspace/app"],
      files: [],
      contentMatches: [{ path: "/workspace/app/src/connect.js", line: 2 }],
      suggestedBreakpoints: [{ bp: "/workspace/app/src/connect.js", line: 2, confidence: "high" }],
    }, false)).toContain("Suggested breakpoints:\n  [high] /workspace/app/src/connect.js:2");
    expect(formatOutput({
      meta,
      roots: [],
      files: [],
      contentMatches: [],
      suggestedBreakpoints: [],
    }, false)).toBe("No candidates discovered.\n");
    expect(formatOutput({ changed: false, status: "enabled", message: "SSH is enabled." }, false))
      .toBe("enabled: SSH is enabled.\n");
    expect(formatOutput({ sessions: [] }, false)).toBe("No persistent sessions.\n");
    expect(formatOutput({
      sessions: [{ sessionId: "session-a", status: "ready", target }],
    }, false)).toBe("session-a\tready\tdemo-app\n");
    expect(formatOutput({
      sessionId: "session-a",
      status: "ready",
      brokerAlive: true,
      sshAlive: true,
      socketAlive: true,
    }, false)).toContain("socketAlive: true");
    expect(formatOutput({
      sessionId: "session-a",
      status: "ready",
      brokerPid: 123,
      socketPath: "/tmp/session.sock",
    }, false)).toContain("brokerPid: 123");
  });
});
