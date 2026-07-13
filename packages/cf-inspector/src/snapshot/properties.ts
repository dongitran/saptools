import { getProperties } from "../inspector/runtime.js";
import type { CdpProperty, InspectorSession } from "../inspector/types.js";
import type { VariableSnapshot } from "../types.js";

import {
  formatPrimitive,
  isPrimitive,
  limitValueLength,
  textTruncationFields,
} from "./values.js";

export const MAX_SCOPE_VARIABLES = 20;
export const MAX_CHILD_VARIABLES = 8;
export const MAX_VARIABLE_DEPTH = 2;

interface DescribedProperty {
  value: string;
  type?: string;
  objectId?: string;
}

export interface CapturedProperties {
  readonly variables: readonly VariableSnapshot[];
  readonly omittedCount?: number;
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
): Promise<CapturedProperties> {
  const properties = await getProperties(session, objectId);
  const limited = properties.slice(0, limit);
  const variables = await Promise.all(
    limited.map(async (prop): Promise<VariableSnapshot> => {
      return await captureProperty(session, prop, depth, maxValueLength);
    }),
  );
  const omittedCount = Math.max(properties.length - limited.length, 0);
  return omittedCount === 0 ? { variables } : { variables, omittedCount };
}

async function captureProperty(
  session: InspectorSession,
  prop: CdpProperty,
  depth: number,
  maxValueLength: number,
): Promise<VariableSnapshot> {
  const name = typeof prop.name === "string" ? prop.name : "?";
  const described = describeProperty(prop);
  const capturedChildren = await capturePropertyChildren(
    session,
    described,
    depth,
    maxValueLength,
  );
  const limited = limitValueLength(described.value, maxValueLength);
  const base: VariableSnapshot = {
    name,
    value: limited.text,
    ...textTruncationFields(limited),
  };
  const withType = described.type === undefined ? base : { ...base, type: described.type };
  const children = capturedChildren?.variables;
  const withChildren = children === undefined || children.length === 0
    ? withType
    : { ...withType, children };
  const omittedCount = capturedChildren?.omittedCount ?? 0;
  return omittedCount === 0
    ? withChildren
    : { ...withChildren, truncated: true, omittedCount };
}

async function capturePropertyChildren(
  session: InspectorSession,
  described: DescribedProperty,
  depth: number,
  maxValueLength: number,
): Promise<CapturedProperties | undefined> {
  if (described.objectId === undefined || !isExpandable(described.type)) {
    return undefined;
  }
  if (depth <= 0) {
    return await countDepthOmissions(session, described.objectId);
  }
  try {
    return await captureProperties(
      session,
      described.objectId,
      MAX_CHILD_VARIABLES,
      depth - 1,
      maxValueLength,
    );
  } catch {
    return undefined;
  }
}

async function countDepthOmissions(
  session: InspectorSession,
  objectId: string,
): Promise<CapturedProperties | undefined> {
  try {
    const properties = await getProperties(session, objectId);
    return properties.length === 0
      ? undefined
      : { variables: [], omittedCount: properties.length };
  } catch {
    return undefined;
  }
}

export function countPropertyOmissions(captured: CapturedProperties): number {
  return (captured.omittedCount ?? 0) + captured.variables.reduce((total, variable) => {
    const childOmissions = variable.children === undefined
      ? 0
      : countPropertyOmissions({ variables: variable.children });
    return total + (variable.omittedCount ?? 0) + childOmissions;
  }, 0);
}
