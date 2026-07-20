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
  triggerRequest,
  type CliResult,
  type E2eWorkspace,
  type FixtureProcess,
} from "./helpers.js";

interface TargetSetup {
  readonly fixture: FixtureProcess;
  readonly targetArgs: readonly string[];
}

function expectSuccessful(result: CliResult): Readonly<Record<string, unknown>> {
  expect(result.code, result.stderr).toBe(0);
  expect(result.signal).toBeNull();
  return parseJsonObject(result.stdout, "CLI stdout");
}

function expectNoSecrets(value: string): void {
  expect(value).not.toContain(PASSWORD_SENTINEL);
  expect(value).not.toContain(BEARER_SENTINEL);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is not a string`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} is not a number`);
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${label} is not a string array`);
  }
  return value;
}

function eventSequence(events: readonly Readonly<Record<string, unknown>>[], functionName: string): number {
  const event = events.find((candidate) => candidate["functionName"] === functionName);
  if (event === undefined) {
    throw new Error(`missing event for ${functionName}`);
  }
  return requireNumber(event["seq"], `${functionName} sequence`);
}

async function startAndPlan(
  workspace: E2eWorkspace,
  outputs: string[],
  callDepth = 1,
): Promise<TargetSetup> {
  const fixture = await startFixture(workspace);
  expect(fixture.fileUrl).toBe(workspace.appFileUrl);
  const targetArgs = [
    fixture.fileUrl,
    "traceTarget",
    "--port",
    fixture.inspectorPort.toString(),
    "--app-root",
    workspace.appRoot,
    "--call-depth",
    callDepth.toString(),
  ];
  const result = await runCli(workspace, ["plan", ...targetArgs]);
  outputs.push(result.stdout, result.stderr);
  const plan = expectSuccessful(result);
  expect(plan["functionSelector"]).toBe("traceTarget");
  expect(plan["scriptUrl"]).toBe(fixture.fileUrl);
  expect(plan["callDepth"]).toBe(callDepth);
  return { fixture, targetArgs };
}

async function recordTarget(
  workspace: E2eWorkspace,
  setup: TargetSetup,
  outputs: string[],
): Promise<string> {
  const recording = startCli(workspace, [
    "record",
    ...setup.targetArgs,
    "--timeout",
    "30",
    "--max-steps",
    "500",
    "--max-paused-ms",
    "30000",
    "--checkpoint-every",
    "50",
  ]);
  await recording.armed;
  const requestBody = await triggerRequest(setup.fixture);
  const result = await recording.completed;
  outputs.push(result.stdout, result.stderr, requestBody);
  const record = expectSuccessful(result);
  expect(record["status"]).toBe("completed");
  expect(record["stopReason"]).toBe("function-returned");
  expect(requireNumber(record["stepCount"], "stepCount")).toBeGreaterThan(0);
  return requireString(record["runId"], "runId");
}

async function readTimeline(workspace: E2eWorkspace, outputs: string[]): Promise<number> {
  const result = await runCli(workspace, ["show", "latest"]);
  outputs.push(result.stdout, result.stderr);
  const events = objectArray(expectSuccessful(result)["events"], "show events");
  expect(events.some((event) => event["kind"] === "baseline")).toBe(true);
  expect(events.some((event) => event["kind"] === "completed")).toBe(true);
  expect(events.some((event) => (
    event["functionName"] === "appChild" && event["depth"] === 1
  ))).toBe(true);
  expect(events.some((event) => event["functionName"] === "externalStep")).toBe(false);
  return eventSequence(events, "appChild");
}

async function assertChangesAndState(
  workspace: E2eWorkspace,
  childSeq: number,
  outputs: string[],
): Promise<void> {
  const changedResult = await runCli(workspace, ["show", "latest", "--changes-only"]);
  outputs.push(changedResult.stdout, changedResult.stderr);
  const changed = expectSuccessful(changedResult);
  const events = objectArray(changed["events"], "changed events");
  expect(events.length).toBeGreaterThan(0);
  expect(events.every((event) => (
    stringArray(event["changedPaths"], "changed paths").length > 0
  ))).toBe(true);

  const stateResult = await runCli(workspace, ["state", "latest", "--at", childSeq.toString()]);
  outputs.push(stateResult.stdout, stateResult.stderr);
  const stateText = JSON.stringify(expectSuccessful(stateResult)["state"]);
  expect(stateText).toContain("appChild");
  expect(stateText).not.toContain("e2e-external");

  // A 0..childSeq span now honestly reports every changed path instead of
  // collapsing to one replace (see state-diff.ts's localized incomplete+
  // remove safety net), and root prioritization means fewer variables are
  // starved to a tiny "node-limit" placeholder -- both correctly make this
  // real diff larger than the default budget, so raise it rather than
  // asserting on a truncation stub.
  const diffResult = await runCli(workspace, [
    "diff", "latest", "--from", "0", "--to", childSeq.toString(), "--max-output-bytes", "200000",
  ]);
  outputs.push(diffResult.stdout, diffResult.stderr);
  const operations = objectArray(expectSuccessful(diffResult)["operations"], "diff operations");
  expect(operations.length).toBeGreaterThan(0);
}

async function assertRunsAndArtifacts(
  workspace: E2eWorkspace,
  runId: string,
  outputs: string[],
): Promise<void> {
  const runsResult = await runCli(workspace, ["runs", "--limit", "5"]);
  outputs.push(runsResult.stdout, runsResult.stderr);
  const runs = objectArray(expectSuccessful(runsResult)["runs"], "runs");
  expect(runs).toContainEqual(expect.objectContaining({ runId, status: "completed" }));

  const storedFiles = await readStoredFiles(workspace);
  expect(storedFiles.some((file) => file.path.endsWith(".full.json"))).toBe(true);
  expect(storedFiles.some((file) => file.path.endsWith(".patch.json"))).toBe(true);
  expect(storedFiles.some((file) => (
    file.path.endsWith("manifest.json") && file.content.includes('"status": "completed"')
  ))).toBe(true);
  for (const file of storedFiles) {
    expectNoSecrets(file.content);
    expect(file.content).not.toContain("e2e-external");
    expect(file.content).not.toContain("externalStep");
  }
}

async function purgeRun(workspace: E2eWorkspace, runId: string, outputs: string[]): Promise<void> {
  const purgeResult = await runCli(workspace, ["purge", runId]);
  outputs.push(purgeResult.stdout, purgeResult.stderr);
  expect(expectSuccessful(purgeResult)).toMatchObject({ purged: true, runId });
  const emptyRunsResult = await runCli(workspace, ["runs"]);
  outputs.push(emptyRunsResult.stdout, emptyRunsResult.stderr);
  expect(expectSuccessful(emptyRunsResult)).toMatchObject({ total: 0, runs: [] });
}

async function traceFunctionNames(callDepth: number): Promise<readonly string[]> {
  const workspace = await createE2eWorkspace();
  let fixture: FixtureProcess | undefined;
  const outputs: string[] = [];
  try {
    const setup = await startAndPlan(workspace, outputs, callDepth);
    fixture = setup.fixture;
    const runId = await recordTarget(workspace, setup, outputs);
    await stopProcess(fixture.child);
    fixture = undefined;
    const shown = await runCli(workspace, ["show", runId]);
    outputs.push(shown.stdout, shown.stderr);
    const events = objectArray(expectSuccessful(shown)["events"], "show events");
    await purgeRun(workspace, runId, outputs);
    return events.flatMap((event) => (
      typeof event["functionName"] === "string" ? [event["functionName"]] : []
    ));
  } finally {
    if (fixture !== undefined) {
      await stopProcess(fixture.child);
    }
    await cleanupWorkspace(workspace);
    for (const output of outputs) {
      expectNoSecrets(output);
    }
  }
}

test("User can record and inspect a deterministic local function timeline", async () => {
  expect(existsSync(CLI_PATH), `CLI must be built at ${CLI_PATH}`).toBe(true);
  const workspace = await createE2eWorkspace();
  let fixture: FixtureProcess | undefined;
  const outputs: string[] = [];

  try {
    const setup = await startAndPlan(workspace, outputs);
    fixture = setup.fixture;
    const runId = await recordTarget(workspace, setup, outputs);

    await stopProcess(fixture.child);
    outputs.push(fixture.stdout(), fixture.stderr());
    fixture = undefined;
    const childSeq = await readTimeline(workspace, outputs);
    await assertChangesAndState(workspace, childSeq, outputs);
    await assertRunsAndArtifacts(workspace, runId, outputs);
    await purgeRun(workspace, runId, outputs);

    for (const output of outputs) {
      expectNoSecrets(output);
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

test("User can restrict a trace to the selected function with call depth zero", async () => {
  const names = await traceFunctionNames(0);
  expect(names).toContain("traceTarget");
  expect(names).not.toContain("appChild");
  expect(names).not.toContain("appGrandchild");
  expect(names).not.toContain("externalStep");
});

test("User can trace application descendants through call depth two", async () => {
  const names = await traceFunctionNames(2);
  expect(names).toContain("traceTarget");
  expect(names).toContain("appChild");
  expect(names).toContain("appGrandchild");
  expect(names).not.toContain("externalStep");
});
