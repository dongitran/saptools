import { buildBreakpointUrlRegex } from "../pathMapper.js";
import { CfInspectorError } from "../types.js";
import type { BreakpointHandle, RemoteRootSetting } from "../types.js";

import { asString, toResolvedLocations } from "./conversions.js";
import type { CdpSetBreakpointResult, InspectorSession, SetBreakpointInput } from "./types.js";

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
