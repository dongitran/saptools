import { buildBreakpointUrlRegex } from "../pathMapper.js";
import { CfInspectorError } from "../types.js";
import type { BreakpointHandle, RemoteRootSetting } from "../types.js";

import { asString, toResolvedLocations } from "./conversions.js";
import type { CdpSetBreakpointResult, InspectorSession, SetBreakpointInput } from "./types.js";

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
  if (input.condition !== undefined && input.condition.length > 0) {
    params["condition"] = input.condition;
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
