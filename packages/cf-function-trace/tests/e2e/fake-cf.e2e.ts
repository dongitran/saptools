import { readFile, readdir } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  cleanupWorkspace,
  createE2eWorkspace,
  materializeFakeCf,
  parseJsonObject,
  startCli,
  startFixture,
  stopProcess,
  triggerRequest,
  type FixtureProcess,
  type RunningCli,
} from "./helpers.js";

interface FakeCfLogEntry {
  readonly event: string;
  readonly args?: readonly string[];
  readonly localPort?: number;
}

function parseLogEntries(raw: string): readonly FakeCfLogEntry[] {
  return raw.trim().split("\n").filter((line) => line.length > 0).map((line) => {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || typeof Reflect.get(value, "event") !== "string") {
      throw new Error("fake CF log entry is invalid");
    }
    const args = Reflect.get(value, "args");
    const localPort = Reflect.get(value, "localPort");
    return {
      event: String(Reflect.get(value, "event")),
      ...(Array.isArray(args) && args.every((item) => typeof item === "string") ? { args } : {}),
      ...(typeof localPort === "number" ? { localPort } : {}),
    };
  });
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const unavailable = (): void => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", unavailable);
    socket.once("timeout", unavailable);
  });
}

function expectSelectors(entries: readonly FakeCfLogEntry[]): void {
  const sshCommands = entries.filter((entry) => entry.args?.[0] === "ssh");
  expect(sshCommands.some((entry) => {
    const command = entry.args?.join(" ") ?? "";
    return command.includes("ssh demo-app --process worker -i 2 --disable-pseudo-tty -c")
      && command.includes("requested_node_pid=9876");
  })).toBe(true);
  expect(sshCommands.some((entry) => (
    (entry.args?.join(" ") ?? "").includes("ssh demo-app --process worker -i 2 -N -L")
  ))).toBe(true);
}

async function expectDebuggerStateEmpty(home: string): Promise<void> {
  const raw = await readFile(join(home, ".saptools", "cf-debugger-state-v2.json"), "utf8");
  expect(parseJsonObject(raw, "cf-debugger state")["sessions"]).toEqual([]);
  const homes = await readdir(join(home, ".saptools", "cf-debugger-homes-v2")).catch(() => []);
  expect(homes).toEqual([]);
}

test("User can trace through a selector-aware fake CF tunnel and clean it up", async () => {
  const workspace = await createE2eWorkspace();
  const fakeCf = await materializeFakeCf(workspace);
  let fixture: FixtureProcess | undefined;
  let recording: RunningCli | undefined;
  try {
    fixture = await startFixture(workspace);
    const env = {
      SAP_EMAIL: "e2e@example.invalid",
      SAP_PASSWORD: "opaque-e2e-value",
      CF_DEBUGGER_CF_BIN: fakeCf.binPath,
      CF_FUNCTION_TRACE_FAKE_LOG: fakeCf.logPath,
      CF_FUNCTION_TRACE_FAKE_INSPECTOR_PORT: fixture.inspectorPort.toString(),
    };
    recording = startCli(workspace, [
      "record", fixture.fileUrl, "traceTarget",
      "--region", "eu10", "--org", "org-a", "--space", "dev", "--app", "demo-app",
      "--process", "worker", "--instance", "2", "--node-pid", "9876",
      "--tunnel-port", "24321",
      "--app-root", workspace.appRoot, "--call-depth", "0", "--confirm-impact",
    ], env);
    await recording.armed;
    await triggerRequest(fixture);
    const result = await recording.completed;
    expect(result.code, result.stderr).toBe(0);
    expect(parseJsonObject(result.stdout, "record result")).toMatchObject({ status: "completed" });

    const entries = parseLogEntries(await readFile(fakeCf.logPath, "utf8"));
    expectSelectors(entries);
    const tunnelPort = entries.find((entry) => entry.event === "tunnel-start")?.localPort;
    expect(tunnelPort).toBeDefined();
    expect(entries.some((entry) => entry.event === "tunnel-stop" && entry.localPort === tunnelPort)).toBe(true);
    if (tunnelPort !== undefined) {
      await expect(canConnect(tunnelPort)).resolves.toBe(false);
    }
    await expectDebuggerStateEmpty(workspace.home);
  } finally {
    if (recording !== undefined) {
      await stopProcess(recording.child);
    }
    if (fixture !== undefined) {
      await stopProcess(fixture.child);
    }
    await cleanupWorkspace(workspace);
  }
});
