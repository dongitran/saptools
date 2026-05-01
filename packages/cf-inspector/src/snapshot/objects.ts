import type { CdpEvalResult, InspectorSession } from "../inspector.js";
import type { CapturedExpression } from "../types.js";

import {
  captureProperties,
  MAX_SCOPE_VARIABLES,
  MAX_VARIABLE_DEPTH,
} from "./properties.js";
import { limitValueLength, toStructuredValue } from "./values.js";

function objectIdFromEvalResult(result: CdpEvalResult): string | undefined {
  const inner = result.result;
  if (inner?.type !== "object") {
    return undefined;
  }
  const objectId = inner.objectId;
  if (typeof objectId !== "string" || objectId.length === 0) {
    return undefined;
  }
  return objectId;
}

async function renderObjectCapture(
  session: InspectorSession,
  objectId: string,
  maxValueLength: number,
): Promise<string | undefined> {
  try {
    const properties = await captureProperties(
      session,
      objectId,
      MAX_SCOPE_VARIABLES,
      MAX_VARIABLE_DEPTH,
      maxValueLength,
    );
    const structured: Record<string, unknown> = {};
    for (const variable of properties) {
      structured[variable.name] = toStructuredValue(variable);
    }
    return JSON.stringify(structured);
  } catch {
    return undefined;
  }
}

function normalizeRenderedObjectCapture(rendered: string, original: string): string | undefined {
  if (rendered === "{}" && original !== "Object") {
    return undefined;
  }
  if (original.startsWith("Array(") && rendered === "{\"length\":0}") {
    return "[]";
  }
  return rendered;
}

export async function withSerializedObjectCapture(
  session: InspectorSession,
  expression: string,
  evalResult: CdpEvalResult,
  captured: CapturedExpression,
  maxValueLength: number,
): Promise<CapturedExpression> {
  if (captured.error !== undefined || captured.value === undefined) {
    return captured;
  }
  const objectId = objectIdFromEvalResult(evalResult);
  if (objectId === undefined) {
    return captured;
  }
  const rendered = await renderObjectCapture(session, objectId, maxValueLength);
  if (rendered === undefined) {
    return captured;
  }
  const normalized = normalizeRenderedObjectCapture(rendered, captured.value);
  if (normalized === undefined) {
    return captured;
  }
  const value = limitValueLength(normalized, maxValueLength);
  return captured.type === undefined
    ? { expression, value }
    : { expression, value, type: captured.type };
}
