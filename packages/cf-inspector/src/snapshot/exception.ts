import { getProperties } from "../inspector/runtime.js";
import type { InspectorSession } from "../inspector/types.js";
import type { ExceptionSnapshot, PauseEvent } from "../types.js";

import {
  captureProperties,
  MAX_SCOPE_VARIABLES,
  MAX_VARIABLE_DEPTH,
} from "./properties.js";
import { limitValueLength, toStructuredValue } from "./values.js";

interface CdpExceptionData {
  readonly type?: unknown;
  readonly description?: unknown;
  readonly value?: unknown;
  readonly objectId?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function materializeObject(
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
    if (properties.length === 0) {
      return undefined;
    }
    const structured: Record<string, unknown> = {};
    for (const variable of properties) {
      structured[variable.name] = toStructuredValue(variable);
    }
    return JSON.stringify(structured);
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
  const rendered = await materializeObject(session, objectId, maxValueLength);
  if (rendered !== undefined) {
    const result = buildResult(type, description, rendered, maxValueLength);
    return message === undefined ? result : { ...result, description: limitValueLength(message, maxValueLength) };
  }
  return buildResult(type, description, description ?? "[exception]", maxValueLength);
}

function buildResult(
  type: string | undefined,
  description: string | undefined,
  value: string,
  maxValueLength: number,
): ExceptionSnapshot {
  const safeValue = limitValueLength(value, maxValueLength);
  const base: ExceptionSnapshot = { value: safeValue };
  const withType = type === undefined ? base : { ...base, type };
  return description === undefined ? withType : { ...withType, description: limitValueLength(description, maxValueLength) };
}
