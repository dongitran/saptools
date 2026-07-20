import { expect, test } from "@playwright/test";

import {
  cleanupWorkspace,
  createE2eWorkspace,
  objectArray,
  parseJsonObject,
  runCli,
  startCli,
  startFixture,
  stopProcess,
  triggerRequest,
  triggerThrowingRequest,
  waitForTraceEvents,
  type FixtureProcess,
  type RunningCli,
} from "./helpers.js";

function localArgs(
  fixture: FixtureProcess,
  appRoot: string,
  functionName: string,
  callDepth = "0",
): readonly string[] {
  return [
    fixture.fileUrl,
    functionName,
    "--port",
    fixture.inspectorPort.toString(),
    "--app-root",
    appRoot,
    "--call-depth",
    callDepth,
  ];
}

test("User can complete a trace when the caller handles the selected function error", async () => {
  const workspace = await createE2eWorkspace();
  let fixture: FixtureProcess | undefined;
  let recording: RunningCli | undefined;
  try {
    fixture = await startFixture(workspace);
    recording = startCli(workspace, [
      "record",
      ...localArgs(fixture, workspace.appRoot, "throwingTarget"),
    ]);
    await recording.armed;
    await triggerThrowingRequest(fixture);
    const result = await recording.completed;
    expect(result.code, result.stderr).toBe(0);
    expect(parseJsonObject(result.stdout, "record result")).toMatchObject({
      status: "completed",
      stopReason: "function-returned",
    });
    const shown = await runCli(workspace, ["show", "latest"]);
    expect(shown.code, shown.stderr).toBe(0);
    const events = objectArray(parseJsonObject(shown.stdout, "show result")["events"], "events");
    expect(events.some((event) => event["kind"] === "exception")).toBe(false);
    expect(events.some((event) => event["kind"] === "completed")).toBe(true);
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

test("User can terminate an armed trace with SIGTERM and leave a cancelled run", async () => {
  const workspace = await createE2eWorkspace();
  let fixture: FixtureProcess | undefined;
  let recording: RunningCli | undefined;
  try {
    fixture = await startFixture(workspace);
    recording = startCli(workspace, [
      "record",
      ...localArgs(fixture, workspace.appRoot, "traceTarget"),
    ]);
    await recording.armed;
    expect(recording.child.kill("SIGTERM")).toBe(true);
    const result = await recording.completed;
    expect(result.signal).toBeNull();
    expect(result.code).toBe(130);

    const runs = await runCli(workspace, ["runs"]);
    expect(runs.code, runs.stderr).toBe(0);
    const summaries = objectArray(parseJsonObject(runs.stdout, "runs result")["runs"], "runs");
    expect(summaries).toContainEqual(expect.objectContaining({ status: "cancelled" }));
    await expect(triggerRequest(fixture)).resolves.toContain('"ok":true');
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

test("User can SIGTERM a trace while the target is genuinely paused mid-step and leave it responsive", async () => {
  const workspace = await createE2eWorkspace();
  let fixture: FixtureProcess | undefined;
  let recording: RunningCli | undefined;
  try {
    fixture = await startFixture(workspace);
    // Call depth 2 traces into appChild/appGrandchild too, giving the
    // activation many pause/step cycles so the run is very likely to still
    // be mid-flight — not merely armed and not yet resumed — by the time
    // the poll below observes it and SIGTERM lands.
    recording = startCli(workspace, [
      "record",
      ...localArgs(fixture, workspace.appRoot, "traceTarget", "2"),
    ]);
    await recording.armed;
    const pendingRequest = triggerRequest(fixture);
    // Waiting for two captured events (not just "armed") proves V8 was
    // actually paused at a real breakpoint when SIGTERM is sent below —
    // each event file is written to disk while the debugger still owns
    // that specific pause (see recordState/writeTraceEvent).
    await waitForTraceEvents(workspace, 2);

    expect(recording.child.kill("SIGTERM")).toBe(true);
    const result = await recording.completed;
    expect(result.signal).toBeNull();
    expect(result.code).toBe(130);

    // The activation that was paused when SIGTERM landed must be allowed to
    // finish running to completion rather than staying frozen at its
    // breakpoint — this is the P0 regression: a killed record process must
    // never leave the target app frozen.
    await expect(pendingRequest).resolves.toContain('"ok":true');
    await expect(triggerRequest(fixture)).resolves.toContain('"ok":true');

    const runs = await runCli(workspace, ["runs"]);
    expect(runs.code, runs.stderr).toBe(0);
    const summaries = objectArray(parseJsonObject(runs.stdout, "runs result")["runs"], "runs");
    expect(summaries).toContainEqual(expect.objectContaining({ status: "cancelled" }));
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
