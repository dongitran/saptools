import { createHash } from "node:crypto";

import {
  getPossibleBreakpoints,
  getScriptSource,
  listScripts,
  type BreakLocation,
  type GetPossibleBreakpointsOptions,
  type InspectorSession,
  type ScriptLocation,
} from "@saptools/cf-inspector";

import { TraceDataError } from "./errors.js";
import { resolveFunctionSelector } from "./function-selector.js";
import { resolveRuntimeScript, type RuntimeScript } from "./script-resolver.js";
import type { TracePlan } from "./trace-controller.js";

export interface PlanFunctionTraceInput {
  readonly file: string;
  readonly functionSelector: string;
  readonly appRoots: readonly string[];
  readonly callDepth: number;
}

export interface TracePlannerPort {
  listScripts(): readonly RuntimeScript[];
  getScriptSource(scriptId: string): Promise<string>;
  getPossibleBreakpoints(
    options: GetPossibleBreakpointsOptions,
  ): Promise<readonly BreakLocation[]>;
}

export function createInspectorPlannerPort(session: InspectorSession): TracePlannerPort {
  return {
    listScripts: (): readonly RuntimeScript[] => listScripts(session),
    getScriptSource: async (scriptId): Promise<string> => await getScriptSource(session, scriptId),
    getPossibleBreakpoints: async (options): Promise<readonly BreakLocation[]> => (
      await getPossibleBreakpoints(session, options)
    ),
  };
}

function offsetLocation(source: string, scriptId: string, offset: number): ScriptLocation {
  const preceding = source.slice(0, offset);
  const lastLineBreak = preceding.lastIndexOf("\n");
  return {
    scriptId,
    lineNumber: preceding.split("\n").length - 1,
    columnNumber: offset - lastLineBreak - 1,
  };
}

function compareLocations(left: BreakLocation, right: BreakLocation): number {
  return left.lineNumber - right.lineNumber
    || (left.columnNumber ?? 0) - (right.columnNumber ?? 0);
}

function selectEntry(
  scriptId: string,
  locations: readonly BreakLocation[],
): ScriptLocation {
  const entry = locations
    .filter((location) => location.scriptId === scriptId)
    .sort(compareLocations)[0];
  if (entry === undefined) {
    throw new TraceDataError(
      "BREAKPOINT_NOT_HIT",
      "The selected function has no exact breakable entry location.",
    );
  }
  return {
    scriptId: entry.scriptId,
    lineNumber: entry.lineNumber,
    ...(entry.columnNumber === undefined ? {} : { columnNumber: entry.columnNumber }),
  };
}

export async function planFunctionTrace(
  input: PlanFunctionTraceInput,
  port: TracePlannerPort,
): Promise<TracePlan> {
  const script = resolveRuntimeScript(input.file, port.listScripts(), input.appRoots);
  const source = await port.getScriptSource(script.scriptId);
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const selection = resolveFunctionSelector(script.url, source, input.functionSelector);
  const start = offsetLocation(source, script.scriptId, selection.candidate.bodyStartOffset);
  const end = offsetLocation(source, script.scriptId, selection.candidate.bodyEndOffset);
  const locations = await port.getPossibleBreakpoints({
    start,
    end,
    restrictToFunction: true,
  });
  return {
    functionSelector: selection.candidate.selector,
    scriptId: script.scriptId,
    scriptUrl: script.url,
    sourceHash,
    startLine: start.lineNumber,
    startColumn: start.columnNumber ?? 0,
    endLine: end.lineNumber,
    endColumn: end.columnNumber ?? 0,
    entryLocation: selectEntry(script.scriptId, locations),
    appRoots: input.appRoots,
    callDepth: input.callDepth,
  };
}

export async function planInspectorFunctionTrace(
  session: InspectorSession,
  input: PlanFunctionTraceInput,
): Promise<TracePlan> {
  return await planFunctionTrace(input, createInspectorPlannerPort(session));
}
