import { CfInspectorError } from "../types.js";
import type { ScriptInfo } from "../types.js";

import type { CdpEvalResult, CdpProperty, InspectorSession } from "./types.js";

export async function resume(session: InspectorSession): Promise<void> {
  await session.client.send("Debugger.resume");
}

export async function evaluateOnFrame(
  session: InspectorSession,
  callFrameId: string,
  expression: string,
): Promise<CdpEvalResult> {
  return await session.client.send<CdpEvalResult>("Debugger.evaluateOnCallFrame", {
    callFrameId,
    expression,
    returnByValue: false,
    generatePreview: true,
    silent: true,
  });
}

export async function evaluateGlobal(
  session: InspectorSession,
  expression: string,
): Promise<CdpEvalResult> {
  return await session.client.send<CdpEvalResult>("Runtime.evaluate", {
    expression,
    returnByValue: false,
    generatePreview: true,
    silent: true,
  });
}

export function listScripts(session: InspectorSession): readonly ScriptInfo[] {
  return [...session.scripts.values()];
}

interface CdpCompileResult {
  scriptId?: unknown;
  exceptionDetails?: { text?: unknown; exception?: { description?: unknown } };
}

export async function validateExpression(
  session: InspectorSession,
  expression: string,
): Promise<void> {
  const result = await session.client.send<CdpCompileResult>("Runtime.compileScript", {
    expression,
    sourceURL: "<cf-inspector-validate>",
    persistScript: false,
  });
  if (result.exceptionDetails === undefined) {
    return;
  }
  const description =
    typeof result.exceptionDetails.exception?.description === "string"
      ? result.exceptionDetails.exception.description
      : (typeof result.exceptionDetails.text === "string"
          ? result.exceptionDetails.text
          : "expression failed to compile");
  throw new CfInspectorError("INVALID_EXPRESSION", description);
}

export async function getProperties(
  session: InspectorSession,
  objectId: string,
): Promise<readonly CdpProperty[]> {
  const result = await session.client.send<{ result?: unknown }>("Runtime.getProperties", {
    objectId,
    ownProperties: true,
    accessorPropertiesOnly: false,
    generatePreview: true,
  });
  if (!Array.isArray(result.result)) {
    return [];
  }
  return result.result as readonly CdpProperty[];
}

export type { CdpEvalResult, CdpProperty } from "./types.js";
