import { looksLikeMutation } from "../cli/captureParser.js";
import { evaluateOnFrame, isSideEffectRefusal } from "../inspector/runtime.js";
import type { InspectorSession } from "../inspector/types.js";
import type {
  CallFrameInfo,
  CapturedExpression,
  FrameSnapshot,
} from "../types.js";

import { evalResultToCaptured, sideEffectRefusalToCaptured } from "./evaluation.js";
import { withSerializedObjectCapture } from "./objects.js";
import { limitValueLength, textTruncationFields } from "./values.js";

export const DEFAULT_STACK_DEPTH = 1;
export const MAX_STACK_DEPTH = 64;

function clampDepth(depth: number, frameCount: number): number {
  if (depth <= 0) {
    return 0;
  }
  return Math.min(depth, frameCount, MAX_STACK_DEPTH);
}

function buildBaseFrame(frame: CallFrameInfo): FrameSnapshot {
  const base: FrameSnapshot = {
    functionName: frame.functionName,
    line: frame.lineNumber + 1,
    column: frame.columnNumber + 1,
  };
  return frame.url === undefined ? base : { ...base, url: frame.url };
}

async function captureFrameExpression(
  session: InspectorSession,
  callFrameId: string,
  expression: string,
  maxValueLength: number,
  throwOnSideEffect: boolean | undefined,
): Promise<CapturedExpression> {
  const mutationRisk = throwOnSideEffect === false && looksLikeMutation(expression);
  try {
    const result = await evaluateOnFrame(session, callFrameId, expression, {
      ...(throwOnSideEffect === undefined ? {} : { throwOnSideEffect }),
    });
    if (isSideEffectRefusal(result)) {
      return sideEffectRefusalToCaptured(expression);
    }
    const captured = evalResultToCaptured(expression, result, maxValueLength);
    const serialized = await withSerializedObjectCapture(
      session,
      expression,
      result,
      captured,
      maxValueLength,
    );
    return mutationRisk ? { ...serialized, mutationRisk: true } : serialized;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const limited = limitValueLength(message, maxValueLength);
    const captured: CapturedExpression = {
      expression,
      error: limited.text,
      ...textTruncationFields(limited),
    };
    return mutationRisk ? { ...captured, mutationRisk: true } : captured;
  }
}

async function captureFrameExpressions(
  session: InspectorSession,
  frame: CallFrameInfo,
  expressions: readonly string[],
  maxValueLength: number,
  throwOnSideEffect: boolean | undefined,
): Promise<readonly CapturedExpression[]> {
  if (expressions.length === 0) {
    return [];
  }
  return await Promise.all(
    expressions.map((expression) =>
      captureFrameExpression(
        session,
        frame.callFrameId,
        expression,
        maxValueLength,
        throwOnSideEffect,
      ),
    ),
  );
}

export interface WalkStackOptions {
  readonly stackDepth: number;
  readonly stackCaptures: readonly string[];
  readonly maxValueLength: number;
  readonly throwOnSideEffect?: boolean;
}

export async function walkStack(
  session: InspectorSession,
  callFrames: readonly CallFrameInfo[],
  options: WalkStackOptions,
): Promise<readonly FrameSnapshot[]> {
  const depth = clampDepth(options.stackDepth, callFrames.length);
  if (depth <= 1) {
    return [];
  }
  const slice = callFrames.slice(0, depth);
  return await Promise.all(
    slice.map(async (frame): Promise<FrameSnapshot> => {
      const base = buildBaseFrame(frame);
      if (options.stackCaptures.length === 0) {
        return base;
      }
      const captures = await captureFrameExpressions(
        session,
        frame,
        options.stackCaptures,
        options.maxValueLength,
        options.throwOnSideEffect,
      );
      return { ...base, captures };
    }),
  );
}
