import { evaluateOnFrame } from "../inspector/runtime.js";
import type { InspectorSession } from "../inspector/types.js";
import type {
  CapturedExpression,
  FrameSnapshot,
  PauseEvent,
  SnapshotCaptureResult,
} from "../types.js";

import { evalResultToCaptured } from "./evaluation.js";
import { withSerializedObjectCapture } from "./objects.js";
import { describeProperty } from "./properties.js";
import { captureScopes, selectScopes } from "./scopes.js";
import {
  DEFAULT_MAX_VALUE_LENGTH,
  limitValueLength,
  resolveMaxValueLength,
} from "./values.js";

export interface CaptureSnapshotOptions {
  readonly captures?: readonly string[];
  readonly includeScopes?: boolean;
  readonly maxValueLength?: number;
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
    captures = await captureExpressions(session, top.callFrameId, options.captures, maxValueLength);
  }
  return {
    reason: pause.reason,
    hitBreakpoints: pause.hitBreakpoints,
    capturedAt: new Date().toISOString(),
    ...(topFrame === undefined ? {} : { topFrame }),
    captures,
  };
}

async function captureExpressions(
  session: InspectorSession,
  callFrameId: string,
  captures: readonly string[] | undefined,
  maxValueLength: number,
): Promise<CapturedExpression[]> {
  if (captures === undefined || captures.length === 0) {
    return [];
  }
  return await Promise.all(
    captures.map(async (expression): Promise<CapturedExpression> => {
      return await captureExpression(session, callFrameId, expression, maxValueLength);
    }),
  );
}

async function captureExpression(
  session: InspectorSession,
  callFrameId: string,
  expression: string,
  maxValueLength: number,
): Promise<CapturedExpression> {
  try {
    const result = await evaluateOnFrame(session, callFrameId, expression);
    const captured = evalResultToCaptured(expression, result, maxValueLength);
    return await withSerializedObjectCapture(session, expression, result, captured, maxValueLength);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { expression, error: limitValueLength(message, maxValueLength) };
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
