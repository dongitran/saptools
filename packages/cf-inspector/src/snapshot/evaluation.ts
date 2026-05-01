import type { CdpEvalResult } from "../inspector.js";
import type { CapturedExpression } from "../types.js";

import {
  DEFAULT_MAX_VALUE_LENGTH,
  formatPrimitive,
  isPrimitive,
  limitValueLength,
} from "./values.js";

export function evalResultToCaptured(
  expression: string,
  result: CdpEvalResult,
  maxValueLength = DEFAULT_MAX_VALUE_LENGTH,
): CapturedExpression {
  if (result.exceptionDetails !== undefined) {
    return { expression, error: readEvalError(result, maxValueLength) };
  }
  const inner = result.result;
  if (!inner) {
    return { expression, error: "no result returned" };
  }
  const type = typeof inner.type === "string" ? inner.type : undefined;
  const buildCaptured = (rendered: string): CapturedExpression => {
    const sanitized = limitValueLength(rendered, maxValueLength);
    const base: CapturedExpression = { expression, value: sanitized };
    return type === undefined ? base : { ...base, type };
  };

  if (type === "string" && typeof inner.value === "string") {
    return buildCaptured(JSON.stringify(inner.value));
  }
  if ((type === "number" || type === "boolean" || type === "bigint") && isPrimitive(inner.value)) {
    return buildCaptured(formatPrimitive(inner.value));
  }
  if (typeof inner.description === "string") {
    return buildCaptured(inner.description);
  }
  if (isPrimitive(inner.value)) {
    return buildCaptured(formatPrimitive(inner.value));
  }
  return buildCaptured("undefined");
}

function readEvalError(result: CdpEvalResult, maxValueLength: number): string {
  const text =
    typeof result.exceptionDetails?.exception?.description === "string"
      ? result.exceptionDetails.exception.description
      : (typeof result.exceptionDetails?.text === "string" ? result.exceptionDetails.text : "evaluation failed");
  return limitValueLength(text, maxValueLength);
}
