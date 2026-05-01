import { getProperties } from "../inspector/runtime.js";
import type { CdpProperty, InspectorSession } from "../inspector/types.js";
import type { VariableSnapshot } from "../types.js";

import { formatPrimitive, isPrimitive, limitValueLength } from "./values.js";

export const MAX_SCOPE_VARIABLES = 20;
export const MAX_CHILD_VARIABLES = 8;
export const MAX_VARIABLE_DEPTH = 2;

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

export function describeProperty(prop: CdpProperty): DescribedProperty {
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

function isExpandable(type: string | undefined): boolean {
  return type === "object" || type === "function";
}

export async function captureProperties(
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
      return await captureProperty(session, prop, depth, maxValueLength);
    }),
  );
  return variables;
}

async function captureProperty(
  session: InspectorSession,
  prop: CdpProperty,
  depth: number,
  maxValueLength: number,
): Promise<VariableSnapshot> {
  const name = typeof prop.name === "string" ? prop.name : "?";
  const described = describeProperty(prop);
  const children = await capturePropertyChildren(session, described, depth, maxValueLength);
  const sanitizedValue = limitValueLength(described.value, maxValueLength);
  const base: VariableSnapshot = { name, value: sanitizedValue };
  const withType = described.type === undefined ? base : { ...base, type: described.type };
  return children === undefined ? withType : { ...withType, children };
}

async function capturePropertyChildren(
  session: InspectorSession,
  described: DescribedProperty,
  depth: number,
  maxValueLength: number,
): Promise<readonly VariableSnapshot[] | undefined> {
  if (depth <= 0 || described.objectId === undefined || !isExpandable(described.type)) {
    return undefined;
  }
  try {
    const nested = await captureProperties(
      session,
      described.objectId,
      MAX_CHILD_VARIABLES,
      depth - 1,
      maxValueLength,
    );
    return nested.length > 0 ? nested : undefined;
  } catch {
    return undefined;
  }
}
