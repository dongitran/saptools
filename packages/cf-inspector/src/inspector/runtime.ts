import { CfInspectorError } from "../types.js";
import type { ScriptInfo } from "../types.js";

import type { CdpEvalResult, CdpProperty, InspectorSession } from "./types.js";

export type PauseOnExceptionsState = "none" | "uncaught" | "caught" | "all";

export interface EvaluateOnFrameOptions {
  readonly throwOnSideEffect?: boolean;
  readonly objectGroup?: string;
}

export interface StepIntoOptions {
  readonly breakOnAsyncCall?: boolean;
}

export async function resume(session: InspectorSession): Promise<void> {
  await session.client.send("Debugger.resume");
  session.debuggerState.paused = false;
  delete session.debuggerState.currentPause;
}

export async function setPauseOnExceptions(
  session: InspectorSession,
  state: PauseOnExceptionsState,
): Promise<void> {
  await session.client.send("Debugger.setPauseOnExceptions", { state });
}

export async function setAsyncCallStackDepth(
  session: InspectorSession,
  maxDepth: number,
): Promise<void> {
  await session.client.send("Debugger.setAsyncCallStackDepth", { maxDepth });
}

export async function evaluateOnFrame(
  session: InspectorSession,
  callFrameId: string,
  expression: string,
  options: EvaluateOnFrameOptions = {},
): Promise<CdpEvalResult> {
  return await session.client.send<CdpEvalResult>("Debugger.evaluateOnCallFrame", {
    callFrameId,
    expression,
    returnByValue: false,
    generatePreview: true,
    silent: true,
    ...(options.throwOnSideEffect === undefined
      ? {}
      : { throwOnSideEffect: options.throwOnSideEffect }),
    ...(options.objectGroup === undefined ? {} : { objectGroup: options.objectGroup }),
  });
}

export function isSideEffectRefusal(result: CdpEvalResult): boolean {
  const classNames = [
    result.result?.className,
    result.exceptionDetails?.exception?.className,
  ];
  const descriptions = [
    result.result?.description,
    result.exceptionDetails?.exception?.description,
  ];
  const isEvalError = classNames.includes("EvalError");
  return isEvalError && descriptions.some(
    (description) =>
      typeof description === "string" &&
      description.toLowerCase().includes("possible side-effect in debug-evaluate"),
  );
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

export async function runSetupEvals(
  session: InspectorSession,
  expressions: readonly string[],
): Promise<void> {
  for (const expression of expressions) {
    const result = await evaluateGlobal(session, expression);
    if (result.exceptionDetails !== undefined) {
      throw new CfInspectorError(
        "SETUP_EVAL_FAILED",
        exceptionDetailsMessage(result, "setup evaluation failed"),
      );
    }
  }
}

function exceptionDetailsMessage(result: CdpEvalResult, fallback: string): string {
  return typeof result.exceptionDetails?.exception?.description === "string"
    ? result.exceptionDetails.exception.description
    : (typeof result.exceptionDetails?.text === "string"
        ? result.exceptionDetails.text
        : fallback);
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

export async function getScriptSource(
  session: InspectorSession,
  scriptId: string,
): Promise<string> {
  if (scriptId.trim().length === 0) {
    throw new CfInspectorError("INVALID_ARGUMENT", "scriptId must not be empty");
  }
  const result = await session.client.send<{ readonly scriptSource?: unknown }>(
    "Debugger.getScriptSource",
    { scriptId },
  );
  if (typeof result.scriptSource !== "string") {
    throw new CfInspectorError(
      "CDP_REQUEST_FAILED",
      "Debugger.getScriptSource did not return scriptSource",
    );
  }
  return result.scriptSource;
}

export async function stepInto(
  session: InspectorSession,
  options: StepIntoOptions = {},
): Promise<void> {
  await session.client.send("Debugger.stepInto", {
    ...(options.breakOnAsyncCall === undefined
      ? {}
      : { breakOnAsyncCall: options.breakOnAsyncCall }),
  });
}

export async function stepOver(session: InspectorSession): Promise<void> {
  await session.client.send("Debugger.stepOver");
}

export async function stepOut(session: InspectorSession): Promise<void> {
  await session.client.send("Debugger.stepOut");
}

export async function releaseObject(
  session: InspectorSession,
  objectId: string,
): Promise<void> {
  await session.client.send("Runtime.releaseObject", { objectId });
}

export async function releaseObjectGroup(
  session: InspectorSession,
  objectGroup: string,
): Promise<void> {
  await session.client.send("Runtime.releaseObjectGroup", { objectGroup });
}

export type { CdpEvalResult, CdpProperty } from "./types.js";
