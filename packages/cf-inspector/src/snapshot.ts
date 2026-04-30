import { performance } from "node:perf_hooks";

import { evaluateOnFrame, getProperties } from "./inspector.js";
import type { CdpEvalResult, CdpProperty, InspectorSession } from "./inspector.js";
import type {
  CallFrameInfo,
  CapturedExpression,
  FrameSnapshot,
  PauseEvent,
  ScopeSnapshot,
  SnapshotResult,
  VariableSnapshot,
} from "./types.js";

const MAX_SCOPES = 3;
const MAX_SCOPE_VARIABLES = 20;
const MAX_CHILD_VARIABLES = 8;
const MAX_VARIABLE_DEPTH = 2;
const MAX_VALUE_LENGTH = 240;
const SENSITIVE_NAME_REGEX = /(pass(?:word)?|token|secret|api[_-]?key|authorization|cookie|session|private[_-]?key)/i;

const PRIORITY_BY_TYPE: Readonly<Record<string, number>> = {
  local: 0,
  arguments: 1,
  block: 2,
  closure: 3,
  catch: 4,
  with: 5,
  module: 6,
  script: 7,
};

interface DescribedProperty {
  value: string;
  type?: string;
  objectId?: string;
}

function buildDescribed(value: string, type: string | undefined, objectId?: string): DescribedProperty {
  const base: DescribedProperty = { value };
  if (type !== undefined) {
    base.type = type;
  }
  if (objectId !== undefined) {
    base.objectId = objectId;
  }
  return base;
}

function describeProperty(prop: CdpProperty): DescribedProperty {
  const value = prop.value;
  if (value === undefined) {
    return { value: "undefined" };
  }
  const type = typeof value.type === "string" ? value.type : undefined;
  const objectId = typeof value.objectId === "string" ? value.objectId : undefined;
  if (type === "undefined") {
    return buildDescribed("undefined", type);
  }
  if (type === "string" && typeof value.value === "string") {
    return buildDescribed(JSON.stringify(value.value), type);
  }
  if (
    (type === "number" || type === "boolean" || type === "bigint" || type === "symbol") &&
    isPrimitive(value.value)
  ) {
    return buildDescribed(formatPrimitive(value.value), type);
  }
  if (typeof value.description === "string") {
    return buildDescribed(value.description, type, objectId);
  }
  if (isPrimitive(value.value)) {
    return buildDescribed(formatPrimitive(value.value), type);
  }
  if (objectId === undefined) {
    return buildDescribed("undefined", type);
  }
  return buildDescribed("[object]", type, objectId);
}

function isPrimitive(value: unknown): value is string | number | boolean | bigint | symbol {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean" || t === "bigint" || t === "symbol";
}

function formatPrimitive(value: string | number | boolean | bigint | symbol): string {
  if (typeof value === "symbol") {
    return value.toString();
  }
  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }
  return String(value);
}

function sanitizeValue(name: string, raw: string): string {
  if (SENSITIVE_NAME_REGEX.test(name)) {
    return "[REDACTED]";
  }
  if (raw.length <= MAX_VALUE_LENGTH) {
    return raw;
  }
  return `${raw.slice(0, MAX_VALUE_LENGTH)}...`;
}

function isExpandable(type: string | undefined): boolean {
  return type === "object" || type === "function";
}

async function captureProperties(
  session: InspectorSession,
  objectId: string,
  limit: number,
  depth: number,
): Promise<readonly VariableSnapshot[]> {
  const properties = await getProperties(session, objectId);
  const limited = properties.slice(0, limit);
  const variables = await Promise.all(
    limited.map(async (prop): Promise<VariableSnapshot> => {
      const name = typeof prop.name === "string" ? prop.name : "?";
      const described = describeProperty(prop);
      let children: readonly VariableSnapshot[] | undefined;
      if (depth > 0 && described.objectId !== undefined && isExpandable(described.type)) {
        try {
          const nested = await captureProperties(
            session,
            described.objectId,
            MAX_CHILD_VARIABLES,
            depth - 1,
          );
          if (nested.length > 0) {
            children = nested;
          }
        } catch {
          // best-effort: skip nested expansion on error
        }
      }
      const sanitizedValue = sanitizeValue(name, described.value);
      const base: VariableSnapshot = { name, value: sanitizedValue };
      const withType = described.type === undefined ? base : { ...base, type: described.type };
      return children === undefined ? withType : { ...withType, children };
    }),
  );
  return variables;
}

function selectScopes(scopeChain: CallFrameInfo["scopeChain"]): CallFrameInfo["scopeChain"] {
  const eligible = scopeChain.filter((scope) => scope.objectId !== undefined && scope.type !== "global");
  return [...eligible]
    .sort((a, b) => priorityOf(a.type) - priorityOf(b.type))
    .slice(0, MAX_SCOPES);
}

function priorityOf(type: string): number {
  return PRIORITY_BY_TYPE[type] ?? Number.MAX_SAFE_INTEGER;
}

async function captureScopes(
  session: InspectorSession,
  frame: CallFrameInfo,
): Promise<readonly ScopeSnapshot[]> {
  const scopes = selectScopes(frame.scopeChain);
  return await Promise.all(
    scopes.map(async (scope): Promise<ScopeSnapshot> => {
      const objectId = scope.objectId;
      if (objectId === undefined) {
        return { type: scope.type, variables: [] };
      }
      const variables = await captureProperties(session, objectId, MAX_SCOPE_VARIABLES, MAX_VARIABLE_DEPTH);
      return { type: scope.type, variables };
    }),
  );
}

function evalResultToCaptured(expression: string, result: CdpEvalResult): CapturedExpression {
  if (result.exceptionDetails !== undefined) {
    const text =
      typeof result.exceptionDetails.exception?.description === "string"
        ? result.exceptionDetails.exception.description
        : (typeof result.exceptionDetails.text === "string" ? result.exceptionDetails.text : "evaluation failed");
    return { expression, error: text };
  }
  const inner = result.result;
  if (!inner) {
    return { expression, error: "no result returned" };
  }
  const type = typeof inner.type === "string" ? inner.type : undefined;

  const buildCaptured = (rendered: string): CapturedExpression => {
    const sanitized = sanitizeValue(expression, rendered);
    const base: CapturedExpression = { expression, value: sanitized };
    return type === undefined ? base : { ...base, type };
  };

  if (type === "string" && typeof inner.value === "string") {
    return buildCaptured(JSON.stringify(inner.value));
  }
  if (
    (type === "number" || type === "boolean" || type === "bigint") &&
    isPrimitive(inner.value)
  ) {
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

export interface CaptureSnapshotOptions {
  readonly captures?: readonly string[];
}

export async function captureSnapshot(
  session: InspectorSession,
  pause: PauseEvent,
  options: CaptureSnapshotOptions = {},
): Promise<SnapshotResult> {
  const startedAt = performance.now();
  const top = pause.callFrames[0];
  let topFrame: FrameSnapshot | undefined;
  let captures: CapturedExpression[] = [];
  if (top) {
    const scopes = await captureScopes(session, top);
    topFrame = {
      functionName: top.functionName,
      ...(top.url === undefined ? {} : { url: top.url }),
      line: top.lineNumber + 1,
      column: top.columnNumber + 1,
      scopes,
    };
    if (options.captures !== undefined && options.captures.length > 0) {
      captures = await Promise.all(
        options.captures.map(async (expression): Promise<CapturedExpression> => {
          try {
            const result = await evaluateOnFrame(session, top.callFrameId, expression);
            return evalResultToCaptured(expression, result);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return { expression, error: message };
          }
        }),
      );
    }
  }
  const captureDurationMs = Math.round((performance.now() - startedAt) * 1000) / 1000;
  return {
    reason: pause.reason,
    hitBreakpoints: pause.hitBreakpoints,
    capturedAt: new Date().toISOString(),
    captureDurationMs,
    ...(topFrame === undefined ? {} : { topFrame }),
    captures,
  };
}

export const internalsForTesting = {
  sanitizeValue,
  describeProperty,
  selectScopes,
  evalResultToCaptured,
};
