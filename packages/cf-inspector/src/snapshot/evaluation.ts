import type { CdpEvalResult } from "../inspector/types.js";
import { CfInspectorError } from "../types.js";
import type { CapturedExpression } from "../types.js";

import {
  DEFAULT_MAX_VALUE_LENGTH,
  formatPrimitive,
  isPrimitive,
  limitValueLength,
  textTruncationFields,
} from "./values.js";
import type { LimitedValue } from "./values.js";

export function evalResultToCaptured(
  expression: string,
  result: CdpEvalResult,
  maxValueLength = DEFAULT_MAX_VALUE_LENGTH,
): CapturedExpression {
  if (result.exceptionDetails !== undefined) {
    const limited = readEvalError(result, maxValueLength);
    return {
      expression,
      error: limited.text,
      ...textTruncationFields(limited),
    };
  }
  const inner = result.result;
  if (!inner) {
    return { expression, error: "no result returned" };
  }
  const type = typeof inner.type === "string" ? inner.type : undefined;
  const buildCaptured = (rendered: string): CapturedExpression => {
    const limited = limitValueLength(rendered, maxValueLength);
    const base: CapturedExpression = {
      expression,
      value: limited.text,
      ...textTruncationFields(limited),
    };
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

export function sideEffectRefusalToCaptured(expression: string): CapturedExpression {
  const error = new CfInspectorError(
    "MUTATION_NOT_ALLOWED",
    `V8 blocked the capture expression "${expression}" because it may have side effects. Pass --allow-mutation to run it explicitly.`,
  );
  return {
    expression,
    error: `${error.code}: ${error.message}`,
    mutationRisk: true,
    blocked: true,
  };
}

function readEvalError(result: CdpEvalResult, maxValueLength: number): LimitedValue {
  const text =
    typeof result.exceptionDetails?.exception?.description === "string"
      ? result.exceptionDetails.exception.description
      : (typeof result.exceptionDetails?.text === "string" ? result.exceptionDetails.text : "evaluation failed");
  return limitValueLength(text, maxValueLength);
}
