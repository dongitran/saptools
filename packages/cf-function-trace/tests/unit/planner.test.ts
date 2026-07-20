import { describe, expect, it } from "vitest";

import { planFunctionTrace } from "../../src/planner.js";
import type { PlanFunctionTraceInput, TracePlannerPort } from "../../src/planner.js";

const RUNTIME_SOURCE = [
  'const SOURCE_SENTINEL = "never persist source";',
  "class OrderService {",
  "  create(order) {",
  "    const id = order.id;",
  "    return id;",
  "  }",
  "}",
].join("\n");

const PLAN_INPUT: PlanFunctionTraceInput = {
  file: "dist/order.js",
  functionSelector: "OrderService.create",
  appRoots: ["/home/vcap/app"],
  callDepth: 1,
};

interface TestPlannerPort extends TracePlannerPort {
  readonly sourceCalls: string[];
  readonly breakpointInputs: Parameters<TracePlannerPort["getPossibleBreakpoints"]>[0][];
}

function createPlannerPort(
  locations: Awaited<ReturnType<TracePlannerPort["getPossibleBreakpoints"]>>,
): TestPlannerPort {
  const sourceCalls: string[] = [];
  const breakpointInputs: Parameters<TracePlannerPort["getPossibleBreakpoints"]>[0][] = [];
  return {
    sourceCalls,
    breakpointInputs,
    listScripts: () => [
      { scriptId: "script-target", url: "file:///home/vcap/app/dist/order.js" },
      { scriptId: "script-dependency", url: "file:///home/vcap/app/node_modules/pkg/index.js" },
    ],
    getScriptSource: async (scriptId): Promise<string> => {
      sourceCalls.push(scriptId);
      return RUNTIME_SOURCE;
    },
    getPossibleBreakpoints: async (options): Promise<Awaited<ReturnType<TracePlannerPort["getPossibleBreakpoints"]>>> => {
      breakpointInputs.push(options);
      return locations;
    },
  };
}

async function plansExactRuntimeEntry(): Promise<void> {
  const port = createPlannerPort([
    { scriptId: "script-target", lineNumber: 3, columnNumber: 4, type: "statement" },
    { scriptId: "script-target", lineNumber: 4, columnNumber: 4, type: "return" },
  ]);
  const plan = await planFunctionTrace(PLAN_INPUT, port);

  expect(port.sourceCalls).toEqual(["script-target"]);
  expect(port.breakpointInputs).toEqual([{
    start: { scriptId: "script-target", lineNumber: 2, columnNumber: 17 },
    end: { scriptId: "script-target", lineNumber: 5, columnNumber: 3 },
    restrictToFunction: true,
  }]);
  expect(plan).toEqual({
    functionSelector: "OrderService.create",
    scriptId: "script-target",
    scriptUrl: "file:///home/vcap/app/dist/order.js",
    sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    startLine: 2,
    startColumn: 17,
    endLine: 5,
    endColumn: 3,
    entryLocation: { scriptId: "script-target", lineNumber: 3, columnNumber: 4 },
    appRoots: ["/home/vcap/app"],
    callDepth: 1,
  });
  expect(JSON.stringify(plan)).not.toContain("SOURCE_SENTINEL");
}

async function rejectsMissingEntry(): Promise<void> {
  await expect(planFunctionTrace(PLAN_INPUT, createPlannerPort([]))).rejects.toMatchObject({
    code: "BREAKPOINT_NOT_HIT",
  });
}

async function rejectsForeignEntry(): Promise<void> {
  const port = createPlannerPort([{ scriptId: "script-other", lineNumber: 3, columnNumber: 4 }]);
  await expect(planFunctionTrace(PLAN_INPUT, port)).rejects.toMatchObject({
    code: "BREAKPOINT_NOT_HIT",
  });
}

describe("function trace planner", () => {
  it("plans the first exact breakable location without retaining runtime source", plansExactRuntimeEntry);
  it("fails closed when the selected function has no breakable entry", rejectsMissingEntry);
  it("rejects a possible location from another runtime script", rejectsForeignEntry);
});
