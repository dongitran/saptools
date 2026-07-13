import type { CdpEvalResult, InspectorSession } from "../inspector/types.js";
import type { CapturedExpression } from "../types.js";

import {
  captureProperties,
  countPropertyOmissions,
  MAX_SCOPE_VARIABLES,
  MAX_VARIABLE_DEPTH,
} from "./properties.js";
import {
  limitValueLength,
  textTruncationFields,
  toStructuredValue,
} from "./values.js";

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

interface RenderedObjectCapture {
  readonly value: string;
  readonly omittedCount: number;
}

async function renderObjectCapture(
  session: InspectorSession,
  objectId: string,
): Promise<RenderedObjectCapture | undefined> {
  try {
    const captured = await captureProperties(
      session,
      objectId,
      MAX_SCOPE_VARIABLES,
      MAX_VARIABLE_DEPTH,
      Number.MAX_SAFE_INTEGER,
    );
    const structured: Record<string, unknown> = {};
    for (const variable of captured.variables) {
      structured[variable.name] = toStructuredValue(variable);
    }
    return {
      value: JSON.stringify(structured),
      omittedCount: countPropertyOmissions(captured),
    };
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
  const rendered = await renderObjectCapture(session, objectId);
  if (rendered === undefined) {
    return captured;
  }
  const normalized = normalizeRenderedObjectCapture(rendered.value, captured.value);
  if (normalized === undefined) {
    return captured;
  }
  const limited = limitValueLength(normalized, maxValueLength);
  const base: CapturedExpression = {
    expression,
    value: limited.text,
    ...textTruncationFields(limited),
    ...(captured.type === undefined ? {} : { type: captured.type }),
  };
  return rendered.omittedCount === 0
    ? base
    : { ...base, truncated: true, omittedCount: rendered.omittedCount };
}
