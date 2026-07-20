import { describe, expect, it } from "vitest";

import {
  buildNodeInspectorCommand,
  parseNodeInspectorMarkers,
  resolveNodeTarget,
} from "../../src/cloud-foundry/node-process.js";

describe("Cloud Foundry Node process targeting", () => {
  it("defaults legacy targets to the web process and instance zero", () => {
    expect(resolveNodeTarget({})).toEqual({ process: "web", instance: 0 });
  });

  it("normalizes explicit process, instance, and Node PID selectors", () => {
    expect(resolveNodeTarget({ process: " worker ", instance: 2, nodePid: 4312 })).toEqual({
      process: "worker",
      instance: 2,
      nodePid: 4312,
    });
  });

  it.each([
    [{ process: "" }, "process"],
    [{ process: "--instance" }, "process"],
    [{ process: "web\nworker" }, "process"],
    [{ instance: -1 }, "instance"],
    [{ instance: 1.5 }, "instance"],
    [{ nodePid: 0 }, "nodePid"],
    [{ nodePid: Number.MAX_SAFE_INTEGER + 1 }, "nodePid"],
  ] as const)("rejects unsafe selector %j", (input, field) => {
    expect(() => resolveNodeTarget(input)).toThrow(expect.objectContaining({
      code: "UNSAFE_INPUT",
      message: expect.stringContaining(field),
    }));
  });

  it("builds a fixed proc-based command for one explicit PID", () => {
    const command = buildNodeInspectorCommand(4312);

    expect(command).toContain("requested_node_pid=4312");
    expect(command).toContain("/proc/[0-9]*");
    expect(command).toContain('kill -USR1 "$selected_pid"');
    expect(command).not.toContain("pidof node");
    expect(command).not.toContain("cmdline");
  });

  it("auto-selects the app-port listener when several Node processes exist", () => {
    const command = buildNodeInspectorCommand();

    expect(command).toContain("requested_node_pid=");
    expect(command).toContain("find_app_port_listener");
    expect(command).toContain("printf '%04X' \"$PORT\"");
    expect(command).toContain('is_node_pid "$app_port_pid"');
    // Falls back to a safe refusal when the app port cannot disambiguate.
    expect(command).toContain("saptools-inspector-node-ambiguous=$candidate_pids");
    // Selection stays proc/socket based — no process-name heuristics.
    expect(command).not.toContain("pidof");
    expect(command).not.toContain("cmdline");
  });

  it("parses a ready marker only when the selected PID owns the inspector", () => {
    expect(parseNodeInspectorMarkers([
      "saptools-inspector-node-pid=4312",
      "saptools-inspector-owner-pid=4312",
      "saptools-inspector-ready",
    ].join("\n"))).toEqual({ remoteNodePid: 4312 });
  });

  it("fails closed when no Node process exists", () => {
    expect(() => parseNodeInspectorMarkers("saptools-inspector-node-not-found\n")).toThrow(
      expect.objectContaining({ code: "NODE_PROCESS_NOT_FOUND" }),
    );
  });

  it("fails closed and reports bounded PIDs when selection is ambiguous", () => {
    expect(() => parseNodeInspectorMarkers(
      "saptools-inspector-node-ambiguous=11,22,33\n",
    )).toThrow(expect.objectContaining({
      code: "NODE_PROCESS_AMBIGUOUS",
      message: expect.stringContaining("11, 22, 33"),
    }));
  });

  it("rejects an explicit PID that is not a Node process", () => {
    expect(() => parseNodeInspectorMarkers("saptools-inspector-node-invalid=4312\n")).toThrow(
      expect.objectContaining({ code: "NODE_PID_INVALID" }),
    );
  });

  it("rejects an inspector owned by a different process", () => {
    expect(() => parseNodeInspectorMarkers(
      "saptools-inspector-owner-mismatch=4312:9876\n",
    )).toThrow(expect.objectContaining({
      code: "INSPECTOR_OWNER_MISMATCH",
      message: expect.stringContaining("9876"),
    }));
  });

  it("rejects missing or oversized marker output", () => {
    expect(() => parseNodeInspectorMarkers("unrelated output\n")).toThrow(
      expect.objectContaining({ code: "INSPECTOR_NOT_READY" }),
    );
    expect(() => parseNodeInspectorMarkers("x".repeat(65_537))).toThrow(
      expect.objectContaining({ code: "INSPECTOR_OUTPUT_TOO_LARGE" }),
    );
  });
});
