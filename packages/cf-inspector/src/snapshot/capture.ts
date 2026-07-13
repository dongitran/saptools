import { looksLikeMutation } from "../cli/captureParser.js";
import { evaluateOnFrame, isSideEffectRefusal } from "../inspector/runtime.js";
import type { InspectorSession } from "../inspector/types.js";
import type {
  CapturedExpression,
  ExceptionSnapshot,
  FrameSnapshot,
  PauseEvent,
  SnapshotCaptureResult,
} from "../types.js";

import { evalResultToCaptured, sideEffectRefusalToCaptured } from "./evaluation.js";
import { captureException } from "./exception.js";
import { withSerializedObjectCapture } from "./objects.js";
import { describeProperty } from "./properties.js";
import { captureScopes, selectScopes } from "./scopes.js";
import { DEFAULT_STACK_DEPTH, walkStack } from "./stack.js";
import {
  DEFAULT_MAX_VALUE_LENGTH,
  limitValueLength,
  resolveMaxValueLength,
} from "./values.js";

export interface CaptureSnapshotOptions {
  readonly captures?: readonly string[];
  readonly includeScopes?: boolean;
  readonly maxValueLength?: number;
  readonly stackDepth?: number;
  readonly stackCaptures?: readonly string[];
  readonly throwOnSideEffect?: boolean;
}

export async function captureSnapshot(
  session: InspectorSession,
  pause: PauseEvent,
  options: CaptureSnapshotOptions = {},
): Promise<SnapshotCaptureResult> {
  const maxValueLength = resolveMaxValueLength(options.maxValueLength);
  const top = pause.callFrames[0];
  let topFrame: FrameSnapshot | undefined;
  let captures: CapturedExpression[] = [];
  let stack: readonly FrameSnapshot[] = [];
  if (top) {
    topFrame = {
      functionName: top.functionName,
      ...(top.url === undefined ? {} : { url: top.url }),
      line: top.lineNumber + 1,
      column: top.columnNumber + 1,
    };
    if (options.includeScopes === true) {
      const scopes = await captureScopes(session, top, maxValueLength);
      topFrame = { ...topFrame, scopes };
    }
    captures = await captureExpressions(
      session,
      top.callFrameId,
      options.captures,
      maxValueLength,
      options.throwOnSideEffect,
    );
    stack = await walkStack(session, pause.callFrames, {
      stackDepth: options.stackDepth ?? DEFAULT_STACK_DEPTH,
      stackCaptures: options.stackCaptures ?? [],
      maxValueLength,
      ...(options.throwOnSideEffect === undefined
        ? {}
        : { throwOnSideEffect: options.throwOnSideEffect }),
    });
  }
  const exception = await captureException(session, pause, maxValueLength);
  return buildResult({
    pause,
    topFrame,
    captures,
    stack,
    exception,
  });
}

interface BuildResultInput {
  readonly pause: PauseEvent;
  readonly topFrame: FrameSnapshot | undefined;
  readonly captures: readonly CapturedExpression[];
  readonly stack: readonly FrameSnapshot[];
  readonly exception: ExceptionSnapshot | undefined;
}

function buildResult(input: BuildResultInput): SnapshotCaptureResult {
  const base: SnapshotCaptureResult = {
    reason: input.pause.reason,
    hitBreakpoints: input.pause.hitBreakpoints,
    capturedAt: new Date().toISOString(),
    captures: input.captures,
  };
  const withFrame = input.topFrame === undefined ? base : { ...base, topFrame: input.topFrame };
  const withStack = input.stack.length > 0 ? { ...withFrame, stack: input.stack } : withFrame;
  return input.exception === undefined ? withStack : { ...withStack, exception: input.exception };
}

async function captureExpressions(
  session: InspectorSession,
  callFrameId: string,
  captures: readonly string[] | undefined,
  maxValueLength: number,
  throwOnSideEffect: boolean | undefined,
): Promise<CapturedExpression[]> {
  if (captures === undefined || captures.length === 0) {
    return [];
  }
  return await Promise.all(
    captures.map(async (expression): Promise<CapturedExpression> => {
      return await captureExpression(
        session,
        callFrameId,
        expression,
        maxValueLength,
        throwOnSideEffect,
      );
    }),
  );
}

async function captureExpression(
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
    const captured = { expression, error: limitValueLength(message, maxValueLength) };
    return mutationRisk ? { ...captured, mutationRisk: true } : captured;
  }
}

export const internalsForTesting = {
  DEFAULT_MAX_VALUE_LENGTH,
  limitValueLength,
  resolveMaxValueLength,
  describeProperty,
  selectScopes,
  evalResultToCaptured,
};
