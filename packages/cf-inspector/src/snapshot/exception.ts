import { getProperties } from "../inspector/runtime.js";
import type { InspectorSession } from "../inspector/types.js";
import type { ExceptionSnapshot, PauseEvent } from "../types.js";

import {
  captureProperties,
  countPropertyOmissions,
  MAX_SCOPE_VARIABLES,
  MAX_VARIABLE_DEPTH,
} from "./properties.js";
import { limitValueLength, toStructuredValue } from "./values.js";
import type { LimitedValue } from "./values.js";

interface CdpExceptionData {
  readonly type?: unknown;
  readonly description?: unknown;
  readonly value?: unknown;
  readonly objectId?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface MaterializedObject {
  readonly value: string;
  readonly omittedCount: number;
}

async function materializeObject(
  session: InspectorSession,
  objectId: string,
): Promise<MaterializedObject | undefined> {
  try {
    const captured = await captureProperties(
      session,
      objectId,
      MAX_SCOPE_VARIABLES,
      MAX_VARIABLE_DEPTH,
      Number.MAX_SAFE_INTEGER,
    );
    if (captured.variables.length === 0) {
      return undefined;
    }
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

async function readPropertyDescription(
  session: InspectorSession,
  objectId: string,
  name: string,
): Promise<string | undefined> {
  try {
    const properties = await getProperties(session, objectId);
    for (const prop of properties) {
      if (prop.name !== name) {
        continue;
      }
      const value = prop.value;
      if (value === undefined) {
        continue;
      }
      if (typeof value.value === "string") {
        return value.value;
      }
      if (typeof value.description === "string") {
        return value.description;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function captureException(
  session: InspectorSession,
  pause: PauseEvent,
  maxValueLength: number,
): Promise<ExceptionSnapshot | undefined> {
  if (pause.reason !== "exception" && pause.reason !== "promiseRejection") {
    return undefined;
  }
  const data = pause.data;
  if (typeof data !== "object" || data === null) {
    return { error: "no exception data attached" };
  }
  const candidate = data as CdpExceptionData;
  const type = asString(candidate.type);
  const description = asString(candidate.description);
  if (typeof candidate.value === "string") {
    return buildResult(type, description, JSON.stringify(candidate.value), maxValueLength);
  }
  if (typeof candidate.value === "number" || typeof candidate.value === "boolean") {
    return buildResult(type, description, String(candidate.value), maxValueLength);
  }
  const objectId = asString(candidate.objectId);
  if (objectId === undefined) {
    if (description !== undefined) {
      return buildResult(type, description, description, maxValueLength);
    }
    return { error: "exception data has no objectId or value" };
  }
  const message = await readPropertyDescription(session, objectId, "message");
  const rendered = await materializeObject(session, objectId);
  if (rendered !== undefined) {
    return buildResult(
      type,
      message ?? description,
      rendered.value,
      maxValueLength,
      rendered.omittedCount,
    );
  }
  return buildResult(type, description, description ?? "[exception]", maxValueLength);
}

function buildResult(
  type: string | undefined,
  description: string | undefined,
  value: string,
  maxValueLength: number,
  omittedCount = 0,
): ExceptionSnapshot {
  const limitedValue = limitValueLength(value, maxValueLength);
  const limitedDescription = description === undefined
    ? undefined
    : limitValueLength(description, maxValueLength);
  const base: ExceptionSnapshot = {
    value: limitedValue.text,
    ...exceptionTruncationFields(limitedValue, limitedDescription),
  };
  const withType = type === undefined ? base : { ...base, type };
  const withDescription = limitedDescription === undefined
    ? withType
    : { ...withType, description: limitedDescription.text };
  return omittedCount === 0
    ? withDescription
    : { ...withDescription, truncated: true, omittedCount };
}

function exceptionTruncationFields(
  value: LimitedValue,
  description: LimitedValue | undefined,
): Pick<
  ExceptionSnapshot,
  "truncated" | "originalLength" | "valueOriginalLength" | "descriptionOriginalLength"
> {
  const valueLength = value.truncated ? value.originalLength : undefined;
  const descriptionLength = description?.truncated === true
    ? description.originalLength
    : undefined;
  const lengths = [valueLength, descriptionLength].filter(
    (length): length is number => length !== undefined,
  );
  if (lengths.length === 0) {
    return {};
  }
  return {
    truncated: true,
    originalLength: Math.max(...lengths),
    ...(valueLength === undefined ? {} : { valueOriginalLength: valueLength }),
    ...(descriptionLength === undefined
      ? {}
      : { descriptionOriginalLength: descriptionLength }),
  };
}
