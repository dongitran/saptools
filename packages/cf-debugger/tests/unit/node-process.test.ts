import { describe, expect, it } from "vitest";

import {
  buildNodeInspectorCommand,
  DEFAULT_NODE_INSPECTOR_PORT,
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

  it("snapshots the proc-based command contract without executing its signal branch", () => {
    const command = buildNodeInspectorCommand(4312, 9230);
    const lines = command.split("\n");

    expect({
      header: lines.slice(0, 2),
      functions: lines.filter((line) => line.endsWith("() {")),
      optimizedLookup: lines.filter((line) => line.includes("-lname")),
      signal: lines.find((line) => line.includes("kill -USR1")),
      pollLookup: lines.filter((line) => line.includes("find_selected_inspector_owner")),
      pollSleep: lines.find((line) => line.includes("sleep 0.25")),
    }).toMatchInlineSnapshot(`
      {
        "functions": [
          "is_node_pid() {",
          "find_listener_inode() {",
          "find_inode_owner_fallback() {",
          "find_inode_owner() {",
          "pid_owns_inode() {",
          "find_listener_pid() {",
          "find_inspector_owner() {",
          "find_selected_inspector_owner() {",
          "find_app_port_listener() {",
        ],
        "header": [
          "requested_node_pid=4312",
          "inspector_port_hex=240E",
        ],
        "optimizedLookup": [
          "    fd_path="$(find /proc/[0-9]*/fd -lname "socket:\\[$socket_inode\\]" -print -quit 2>/dev/null || true)"",
          "    fd_path="$(find "/proc/$candidate_pid/fd" -lname "socket:\\[$socket_inode\\]" -print -quit 2>/dev/null || true)"",
          "if find /proc/self/fd -lname __saptools_no_match__ -print -quit >/dev/null 2>&1; then",
        ],
        "pollLookup": [
          "find_selected_inspector_owner() {",
          "  owner_pid="$(find_selected_inspector_owner "$selected_pid")"",
        ],
        "pollSleep": "  sleep 0.25 2>/dev/null || sleep 1",
        "signal": "if ! kill -USR1 "$selected_pid" 2>/dev/null; then echo "saptools-inspector-signal-failed=$selected_pid"; exit 0; fi",
      }
    `);

    expect(command).toContain("/proc/[0-9]*");
    expect(command).toContain('kill -USR1 "$selected_pid"');
    expect(command).not.toContain("pidof node");
    expect(command).not.toContain("cmdline");
  });

  it("derives the inspector socket hex from the validated remote port", () => {
    expect(buildNodeInspectorCommand()).toContain(
      `inspector_port_hex=${DEFAULT_NODE_INSPECTOR_PORT.toString(16).toUpperCase()}`,
    );
    expect(buildNodeInspectorCommand(undefined, 9230)).toContain("inspector_port_hex=240E");
    expect(buildNodeInspectorCommand(undefined, 1)).toContain("inspector_port_hex=0001");
    expect(buildNodeInspectorCommand(undefined, 65_535)).toContain("inspector_port_hex=FFFF");
    expect(buildNodeInspectorCommand(undefined, 9230)).not.toContain("find_listener_pid 240D");
  });

  it.each([0, 65_536, 1.5, Number.NaN])("rejects unsafe remote inspector port %s", (remotePort) => {
    expect(() => buildNodeInspectorCommand(undefined, remotePort)).toThrow(expect.objectContaining({
      code: "UNSAFE_INPUT",
      message: expect.stringContaining("remotePort"),
    }));
  });

  it.each([-1, 1.5, Number.NaN])(
    "rejects unsafe explicit PID %s before interpolating shell text",
    (nodePid) => {
      expect(() => buildNodeInspectorCommand(nodePid, 9230)).toThrow(expect.objectContaining({
        code: "UNSAFE_INPUT",
        message: expect.stringContaining("nodePid"),
      }));
    },
  );

  it("uses an escaped find lookup with a safe per-descriptor fallback", () => {
    const command = buildNodeInspectorCommand();

    expect(command).toContain('find /proc/[0-9]*/fd -lname "socket:\\[$socket_inode\\]"');
    expect(command).toContain("find_inode_owner_fallback");
    expect(command).toContain('fd_target="$(readlink "$fd_path" 2>/dev/null || true)"');
  });

  it("checks the selected PID first after signalling and preserves global mismatch detection", () => {
    const command = buildNodeInspectorCommand();
    const selectedLookup = command.indexOf('owner_pid="$(find_selected_inspector_owner "$selected_pid")"');
    const selectedFunction = command.indexOf("find_selected_inspector_owner() {");
    const globalFallback = command.indexOf('find_inode_owner "$socket_inode"', selectedFunction);

    expect(selectedLookup).toBeGreaterThan(command.indexOf('kill -USR1 "$selected_pid"'));
    expect(globalFallback).toBeGreaterThan(selectedFunction);
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
      9230,
    )).toThrow(expect.objectContaining({
      code: "INSPECTOR_OWNER_MISMATCH",
      message: expect.stringContaining("port 9230 is owned by PID 9876"),
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
