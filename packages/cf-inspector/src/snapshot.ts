import { evaluateOnFrame, getProperties } from "./inspector.js";
import type { CdpEvalResult, CdpProperty, InspectorSession } from "./inspector.js";
import { CfInspectorError } from "./types.js";
import type {
  CallFrameInfo,
  CapturedExpression,
  FrameSnapshot,
  PauseEvent,
  ScopeSnapshot,
  SnapshotCaptureResult,
  VariableSnapshot,
} from "./types.js";

const MAX_SCOPES = 3;
const MAX_SCOPE_VARIABLES = 20;
const MAX_CHILD_VARIABLES = 8;
const MAX_VARIABLE_DEPTH = 2;
const DEFAULT_MAX_VALUE_LENGTH = 4096;

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

function resolveMaxValueLength(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_VALUE_LENGTH;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new CfInspectorError(
      "INVALID_ARGUMENT",
      `Invalid maxValueLength: ${value.toString()} — expected a positive integer`,
    );
  }
  return value;
}

function limitValueLength(raw: string, maxValueLength = DEFAULT_MAX_VALUE_LENGTH): string {
  if (raw.length <= maxValueLength) {
    return raw;
  }
  return `${raw.slice(0, maxValueLength)}...`;
}

function isExpandable(type: string | undefined): boolean {
  return type === "object" || type === "function";
}

async function captureProperties(
  session: InspectorSession,
  objectId: string,
  limit: number,
  depth: number,
  maxValueLength: number,
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
            maxValueLength,
          );
          if (nested.length > 0) {
            children = nested;
          }
        } catch {
          // best-effort: skip nested expansion on error
        }
      }
      const sanitizedValue = limitValueLength(described.value, maxValueLength);
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
  maxValueLength: number,
): Promise<readonly ScopeSnapshot[]> {
  const scopes = selectScopes(frame.scopeChain);
  return await Promise.all(
    scopes.map(async (scope): Promise<ScopeSnapshot> => {
      const objectId = scope.objectId;
      if (objectId === undefined) {
        return { type: scope.type, variables: [] };
      }
      try {
        const variables = await captureProperties(
          session,
          objectId,
          MAX_SCOPE_VARIABLES,
          MAX_VARIABLE_DEPTH,
          maxValueLength,
        );
        return { type: scope.type, variables };
      } catch {
        return { type: scope.type, variables: [] };
      }
    }),
  );
}

function evalResultToCaptured(
  expression: string,
  result: CdpEvalResult,
  maxValueLength = DEFAULT_MAX_VALUE_LENGTH,
): CapturedExpression {
  if (result.exceptionDetails !== undefined) {
    const text =
      typeof result.exceptionDetails.exception?.description === "string"
        ? result.exceptionDetails.exception.description
        : (typeof result.exceptionDetails.text === "string" ? result.exceptionDetails.text : "evaluation failed");
    return { expression, error: limitValueLength(text, maxValueLength) };
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

function parseQuotedString(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

function parseNumericIndex(name: string): number | undefined {
  const parsed = Number.parseInt(name, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed.toString() !== name) {
    return undefined;
  }
  return parsed;
}

function scalarFromVariable(variable: VariableSnapshot): unknown {
  const value = variable.value;
  if (variable.type === "string") {
    return parseQuotedString(value);
  }
  if (variable.type === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (variable.type === "boolean") {
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
  }
  if (variable.type === "undefined") {
    return "[undefined]";
  }
  if (variable.type === "bigint") {
    return value;
  }
  return value === "null" ? null : value;
}

function toStructuredValue(variable: VariableSnapshot): unknown {
  const children = variable.children;
  if (children === undefined || children.length === 0) {
    return scalarFromVariable(variable);
  }
  const indexed = children.flatMap((child): readonly [number, unknown][] => {
    const index = parseNumericIndex(child.name);
    if (index === undefined) {
      return [];
    }
    return [[index, toStructuredValue(child)]];
  });
  if (indexed.length > 0) {
    const maxIndex = Math.max(...indexed.map(([index]) => index));
    const out = Array.from({ length: maxIndex + 1 }, () => null as unknown);
    for (const [index, entry] of indexed) {
      out[index] = entry;
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const child of children) {
    out[child.name] = toStructuredValue(child);
  }
  return out;
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
  // Preserve richer built-in descriptions (Date/Map/Set/Promise...) if property
  // expansion only produced an empty object payload.
  if (rendered === "{}" && original !== "Object") {
    return undefined;
  }
  // For empty arrays, property expansion often only yields {"length":0}.
  // Convert it to [] for readability and consistency.
  if (original.startsWith("Array(") && rendered === "{\"length\":0}") {
    return "[]";
  }
  return rendered;
}

async function withSerializedObjectCapture(
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
    if (options.captures !== undefined && options.captures.length > 0) {
      captures = await Promise.all(
        options.captures.map(async (expression): Promise<CapturedExpression> => {
          try {
            const result = await evaluateOnFrame(session, top.callFrameId, expression);
            const captured = evalResultToCaptured(expression, result, maxValueLength);
            return await withSerializedObjectCapture(
              session,
              expression,
              result,
              captured,
              maxValueLength,
            );
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return { expression, error: limitValueLength(message, maxValueLength) };
          }
        }),
      );
    }
  }
  return {
    reason: pause.reason,
    hitBreakpoints: pause.hitBreakpoints,
    capturedAt: new Date().toISOString(),
    ...(topFrame === undefined ? {} : { topFrame }),
    captures,
  };
}

export const internalsForTesting = {
  DEFAULT_MAX_VALUE_LENGTH,
  limitValueLength,
  resolveMaxValueLength,
  describeProperty,
  selectScopes,
  evalResultToCaptured,
};
