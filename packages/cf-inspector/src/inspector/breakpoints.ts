import { buildBreakpointUrlRegex } from "../pathMapper.js";
import { CfInspectorError } from "../types.js";
import type {
  BreakLocation,
  BreakpointHandle,
  ExactBreakpointHandle,
  GetPossibleBreakpointsOptions,
  RemoteRootSetting,
  ScriptLocation,
  SetBreakpointAtLocationInput,
} from "../types.js";

import {
  asString,
  toBreakLocations,
  toResolvedLocations,
  toScriptLocation,
} from "./conversions.js";
import type {
  CdpPossibleBreakpointsResult,
  CdpSetBreakpointResult,
  CdpSetExactBreakpointResult,
  InspectorSession,
  SetBreakpointInput,
} from "./types.js";

const HITS_GLOBAL = "globalThis.__CFI_HITS";
let counterKeyCounter = 0;

function nextCounterKey(file: string, line: number): string {
  counterKeyCounter += 1;
  return `${file}:${line.toString()}:${counterKeyCounter.toString()}`;
}

function validateHitCount(hitCount: number | undefined): number | undefined {
  if (hitCount === undefined) {
    return undefined;
  }
  if (!Number.isInteger(hitCount) || hitCount <= 0) {
    throw new CfInspectorError(
      "INVALID_HIT_COUNT",
      `hitCount must be a positive integer, received: ${hitCount.toString()}`,
    );
  }
  return hitCount;
}

export function buildHitCountedCondition(
  hitCount: number,
  counterKey: string,
  userCondition: string | undefined,
): string {
  const keyLiteral = JSON.stringify(counterKey);
  const baseCondition = userCondition !== undefined && userCondition.trim().length > 0
    ? `(${userCondition})`
    : "true";
  return [
    "(function(){",
    `var m=(${HITS_GLOBAL}=${HITS_GLOBAL}||{});`,
    `var k=${keyLiteral};`,
    "m[k]=(m[k]||0)+1;",
    `if(m[k]<${hitCount.toString()})return false;`,
    `return ${baseCondition};`,
    "})()",
  ].join("");
}

function resolveCondition(
  input: SetBreakpointInput,
): string | undefined {
  const condition = input.condition;
  const hitCount = validateHitCount(input.hitCount);
  if (hitCount === undefined) {
    return condition !== undefined && condition.length > 0 ? condition : undefined;
  }
  const counterKey = nextCounterKey(input.file, input.line);
  return buildHitCountedCondition(hitCount, counterKey, condition);
}

export async function setBreakpoint(
  session: InspectorSession,
  input: SetBreakpointInput,
): Promise<BreakpointHandle> {
  const remoteRoot: RemoteRootSetting = input.remoteRoot ?? { kind: "none" };
  const urlRegex = buildBreakpointUrlRegex({ file: input.file, remoteRoot });
  const params: Record<string, unknown> = {
    lineNumber: input.line - 1,
    urlRegex,
  };
  const condition = resolveCondition(input);
  if (condition !== undefined) {
    params["condition"] = condition;
  }
  const result = await session.client.send<CdpSetBreakpointResult>(
    "Debugger.setBreakpointByUrl",
    params,
  );
  const breakpointId = asString(result.breakpointId);
  if (breakpointId.length === 0) {
    throw new CfInspectorError(
      "CDP_REQUEST_FAILED",
      `setBreakpointByUrl did not return a breakpointId for ${input.file}:${input.line.toString()}`,
    );
  }
  return {
    breakpointId,
    file: input.file,
    line: input.line,
    urlRegex,
    resolvedLocations: toResolvedLocations(result.locations),
  };
}

export async function removeBreakpoint(
  session: InspectorSession,
  breakpointId: string,
): Promise<void> {
  await session.client.send("Debugger.removeBreakpoint", { breakpointId });
}

function validateCoordinate(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new CfInspectorError(
      "INVALID_ARGUMENT",
      `${label} must be a non-negative integer, received: ${value.toString()}`,
    );
  }
}

function validateScriptLocation(location: ScriptLocation, label: string): void {
  if (location.scriptId.trim().length === 0) {
    throw new CfInspectorError("INVALID_ARGUMENT", `${label}.scriptId must not be empty`);
  }
  validateCoordinate(location.lineNumber, `${label}.lineNumber`);
  if (location.columnNumber !== undefined) {
    validateCoordinate(location.columnNumber, `${label}.columnNumber`);
  }
}

function isSameScriptLocation(
  requested: ScriptLocation,
  actual: ScriptLocation,
): boolean {
  return requested.scriptId === actual.scriptId
    && requested.lineNumber === actual.lineNumber
    && (requested.columnNumber ?? 0) === (actual.columnNumber ?? 0);
}

export async function getPossibleBreakpoints(
  session: InspectorSession,
  options: GetPossibleBreakpointsOptions,
): Promise<readonly BreakLocation[]> {
  validateScriptLocation(options.start, "start");
  if (options.end !== undefined) {
    validateScriptLocation(options.end, "end");
    if (options.end.scriptId !== options.start.scriptId) {
      throw new CfInspectorError("INVALID_ARGUMENT", "start and end must refer to the same scriptId");
    }
  }
  const result = await session.client.send<CdpPossibleBreakpointsResult>(
    "Debugger.getPossibleBreakpoints",
    {
      start: options.start,
      ...(options.end === undefined ? {} : { end: options.end }),
      ...(options.restrictToFunction === undefined
        ? {}
        : { restrictToFunction: options.restrictToFunction }),
    },
  );
  if (!Array.isArray(result.locations)) {
    throw new CfInspectorError(
      "CDP_REQUEST_FAILED",
      "Debugger.getPossibleBreakpoints did not return a locations array",
    );
  }
  return toBreakLocations(result.locations);
}

export async function setBreakpointAtLocation(
  session: InspectorSession,
  input: SetBreakpointAtLocationInput,
): Promise<ExactBreakpointHandle> {
  validateScriptLocation(input.location, "location");
  const result = await session.client.send<CdpSetExactBreakpointResult>("Debugger.setBreakpoint", {
    location: input.location,
    ...(input.condition === undefined || input.condition.length === 0
      ? {}
      : { condition: input.condition }),
  });
  const breakpointId = asString(result.breakpointId);
  const actualLocation = toScriptLocation(result.actualLocation);
  const wrongLocation = actualLocation !== undefined
    && !isSameScriptLocation(input.location, actualLocation);
  if (breakpointId.length === 0 || actualLocation === undefined || wrongLocation) {
    if (breakpointId.length > 0) {
      try {
        await removeBreakpoint(session, breakpointId);
      } catch {
        // The invalid binding is already unusable; preserve the validation failure.
      }
    }
    if (wrongLocation) {
      throw new CfInspectorError(
        "INVALID_BREAKPOINT",
        "Debugger.setBreakpoint resolved the breakpoint at a different script, line, or column",
      );
    }
    throw new CfInspectorError(
      "CDP_REQUEST_FAILED",
      "Debugger.setBreakpoint did not return a breakpointId and actualLocation",
    );
  }
  return {
    breakpointId,
    requestedLocation: input.location,
    actualLocation,
  };
}
