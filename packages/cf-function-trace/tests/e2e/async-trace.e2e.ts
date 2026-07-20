import { existsSync } from "node:fs";

import { expect, test } from "@playwright/test";

import {
  BEARER_SENTINEL,
  cleanupWorkspace,
  CLI_PATH,
  createE2eWorkspace,
  objectArray,
  parseJsonObject,
  PASSWORD_SENTINEL,
  readStoredFiles,
  runCli,
  startCli,
  startFixture,
  stopProcess,
  triggerAsyncRequest,
  type CliResult,
  type E2eWorkspace,
  type FixtureProcess,
} from "./helpers.js";

function expectSuccessful(result: CliResult): Readonly<Record<string, unknown>> {
  expect(result.code, result.stderr).toBe(0);
  expect(result.signal).toBeNull();
  return parseJsonObject(result.stdout, "CLI stdout");
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} is not a number`);
  }
  return value;
}

function expectNoSecrets(value: string): void {
  expect(value).not.toContain(PASSWORD_SENTINEL);
  expect(value).not.toContain(BEARER_SENTINEL);
}

function asyncTargetArgs(
  fixture: FixtureProcess,
  workspace: E2eWorkspace,
  extra: readonly string[] = [],
): readonly string[] {
  return [
    fixture.fileUrl,
    "asyncTarget",
    "--port",
    fixture.inspectorPort.toString(),
    "--app-root",
    workspace.appRoot,
    "--call-depth",
    "0",
    ...extra,
  ];
}

test("User can record and diff an async function timeline across awaits", async () => {
  expect(existsSync(CLI_PATH), `CLI must be built at ${CLI_PATH}`).toBe(true);
  const workspace = await createE2eWorkspace();
  let fixture: FixtureProcess | undefined;
  const outputs: string[] = [];

  try {
    fixture = await startFixture(workspace);
    const planResult = await runCli(workspace, ["plan", ...asyncTargetArgs(fixture, workspace)]);
    outputs.push(planResult.stdout, planResult.stderr);
    const plan = expectSuccessful(planResult);
    expect(plan["functionSelector"]).toBe("asyncTarget");
    expect(plan["asynchronous"]).toBe(true);

    const recording = startCli(workspace, [
      "record",
      ...asyncTargetArgs(fixture, workspace),
      "--timeout",
      "30",
      "--max-steps",
      "500",
      "--max-paused-ms",
      "20000",
    ]);
    await recording.armed;
    const body = await triggerAsyncRequest(fixture, 4, "wanted");
    const result = await recording.completed;
    outputs.push(result.stdout, result.stderr, body);

    const record = expectSuccessful(result);
    expect(record["status"]).toBe("completed");
    expect(record["stopReason"]).toBe("function-returned");
    // The async body has several statements on both sides of two awaits.
    expect(requireNumber(record["stepCount"], "stepCount")).toBeGreaterThan(4);

    await stopProcess(fixture.child);
    outputs.push(fixture.stdout(), fixture.stderr());
    fixture = undefined;

    const shown = await runCli(workspace, ["show", "latest"]);
    outputs.push(shown.stdout, shown.stderr);
    const events = objectArray(expectSuccessful(shown)["events"], "events");
    expect(events.some((event) => event["kind"] === "baseline")).toBe(true);
    expect(events.some((event) => event["kind"] === "completed")).toBe(true);
    const asyncPauses = events.filter((event) => event["functionName"] === "asyncTarget");
    expect(asyncPauses.length).toBeGreaterThan(4);

    const changed = await runCli(workspace, ["show", "latest", "--changes-only"]);
    outputs.push(changed.stdout, changed.stderr);
    const changedEvents = objectArray(expectSuccessful(changed)["events"], "changed events");
    // Diffs across the awaits: the phase/total locals mutate step to step.
    expect(changedEvents.length).toBeGreaterThan(1);

    const lastSeq = requireNumber(asyncPauses.at(-1)?.["seq"], "last async sequence");
    const stateResult = await runCli(workspace, ["state", "latest", "--at", lastSeq.toString()]);
    outputs.push(stateResult.stdout, stateResult.stderr);
    const stateText = JSON.stringify(expectSuccessful(stateResult)["state"]);
    expect(stateText).toContain("wanted");

    for (const file of await readStoredFiles(workspace)) {
      expectNoSecrets(file.content);
    }
  } finally {
    if (fixture !== undefined) {
      await stopProcess(fixture.child);
      outputs.push(fixture.stdout(), fixture.stderr());
    }
    await cleanupWorkspace(workspace);
    for (const output of outputs) {
      expectNoSecrets(output);
    }
  }
});

test("User can correlate one async activation with --match amid concurrent traffic", async () => {
  const workspace = await createE2eWorkspace();
  let fixture: FixtureProcess | undefined;
  const outputs: string[] = [];

  try {
    fixture = await startFixture(workspace);
    const recording = startCli(workspace, [
      "record",
      ...asyncTargetArgs(fixture, workspace, ["--match", 'payload.id === "wanted"']),
      "--timeout",
      "30",
      "--max-steps",
      "500",
      "--max-paused-ms",
      "20000",
    ]);
    await recording.armed;
    // A competing activation of the same function is fired first; --match must skip it.
    const competing = triggerAsyncRequest(fixture, 7, "other");
    const wanted = triggerAsyncRequest(fixture, 4, "wanted");
    const result = await recording.completed;
    const settled = await Promise.allSettled([competing, wanted]);
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        outputs.push(outcome.value);
      }
    }
    outputs.push(result.stdout, result.stderr);

    const record = expectSuccessful(result);
    expect(record["status"]).toBe("completed");

    await stopProcess(fixture.child);
    outputs.push(fixture.stdout(), fixture.stderr());
    fixture = undefined;

    const files = await readStoredFiles(workspace);
    const stateFiles = files.filter((file) => file.path.includes("states/"));
    const combined = stateFiles.map((file) => file.content).join("\n");
    expect(combined).toContain("wanted");
    // The concurrent "other" activation was never the traced activation.
    expect(combined).not.toContain("other");
    for (const file of files) {
      expectNoSecrets(file.content);
    }
  } finally {
    if (fixture !== undefined) {
      await stopProcess(fixture.child);
      outputs.push(fixture.stdout(), fixture.stderr());
    }
    await cleanupWorkspace(workspace);
    for (const output of outputs) {
      expectNoSecrets(output);
    }
  }
});
