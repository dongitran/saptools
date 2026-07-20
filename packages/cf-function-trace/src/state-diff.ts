import { canonicalizeState } from "./canonical-state.js";
import type { JsonValue, StatePatch, StatePatchOperation } from "./contracts.js";
import { TraceDataError } from "./errors.js";

type JsonRecord = Record<string, JsonValue>;

function isRecord(value: JsonValue): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valuesEqual(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isIncomplete(value: JsonValue): boolean {
  return isRecord(value) && typeof value["completeness"] === "string" && value["completeness"] !== "complete";
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function childPath(parent: string, key: string): string {
  return `${parent}/${pointerSegment(key)}`;
}

function diffRecords(
  before: JsonRecord,
  after: JsonRecord,
  path: string,
  operations: StatePatchOperation[],
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    diffRecordKey(before, after, path, key, operations);
  }
}

function diffRecordKey(
  before: JsonRecord,
  after: JsonRecord,
  path: string,
  key: string,
  operations: StatePatchOperation[],
): void {
  const nextPath = childPath(path, key);
  const hasBefore = Object.hasOwn(before, key);
  const hasAfter = Object.hasOwn(after, key);
  if (!hasBefore && hasAfter) {
    operations.push({ op: "add", path: nextPath, value: after[key] ?? null });
    return;
  }
  if (hasBefore && !hasAfter) {
    operations.push({ op: "remove", path: nextPath });
    return;
  }
  if (hasBefore && hasAfter) {
    collectOperations(before[key] ?? null, after[key] ?? null, nextPath, operations);
  }
}

function collectOperations(
  before: JsonValue,
  after: JsonValue,
  path: string,
  operations: StatePatchOperation[],
): void {
  if (valuesEqual(before, after)) {
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    if ([...Object.keys(before), ...Object.keys(after)].some(isDangerousSegment)) {
      operations.push({ op: "replace", path, value: after });
      return;
    }
    collectRecordOperations(before, after, path, operations);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    diffArrays(before, after, path, operations);
    return;
  }
  operations.push({ op: "replace", path, value: after });
}

function collectRecordOperations(
  before: JsonRecord,
  after: JsonRecord,
  path: string,
  operations: StatePatchOperation[],
): void {
  const nested: StatePatchOperation[] = [];
  diffRecords(before, after, path, nested);
  const uncertainRemoval = (isIncomplete(before) || isIncomplete(after))
    && nested.some((operation) => operation.op === "remove");
  if (uncertainRemoval) {
    operations.push({ op: "replace", path, value: after });
    return;
  }
  operations.push(...nested);
}

function matchingPrefix(before: readonly JsonValue[], after: readonly JsonValue[]): number {
  const limit = Math.min(before.length, after.length);
  let index = 0;
  while (index < limit && valuesEqual(before[index] ?? null, after[index] ?? null)) {
    index += 1;
  }
  return index;
}

function matchingSuffix(before: readonly JsonValue[], after: readonly JsonValue[], prefix: number): number {
  const limit = Math.min(before.length, after.length) - prefix;
  let count = 0;
  while (count < limit && valuesEqual(before.at(-1 - count) ?? null, after.at(-1 - count) ?? null)) {
    count += 1;
  }
  return count;
}

function diffArrays(
  before: readonly JsonValue[],
  after: readonly JsonValue[],
  path: string,
  operations: StatePatchOperation[],
): void {
  const prefix = matchingPrefix(before, after);
  const suffix = matchingSuffix(before, after, prefix);
  const beforeCount = before.length - prefix - suffix;
  const afterCount = after.length - prefix - suffix;
  const shared = Math.min(beforeCount, afterCount);
  for (let offset = 0; offset < shared; offset += 1) {
    const index = prefix + offset;
    collectOperations(before[index] ?? null, after[index] ?? null, childPath(path, String(index)), operations);
  }
  for (let offset = beforeCount - 1; offset >= afterCount; offset -= 1) {
    operations.push({ op: "remove", path: childPath(path, String(prefix + offset)) });
  }
  for (let offset = beforeCount; offset < afterCount; offset += 1) {
    operations.push({ op: "add", path: childPath(path, String(prefix + offset)), value: after[prefix + offset] ?? null });
  }
}

export function diffStates(beforeValue: unknown, afterValue: unknown): StatePatch {
  const before = canonicalizeState(beforeValue);
  const after = canonicalizeState(afterValue);
  const operations: StatePatchOperation[] = [];
  collectOperations(before.value, after.value, "", operations);
  return {
    before,
    after,
    operations,
    changedPaths: operations.map((operation) => operation.path),
  };
}

function decodePointer(path: string): readonly string[] {
  if (path === "") {
    return [];
  }
  if (!path.startsWith("/")) {
    throw new TraceDataError("INVALID_ARTIFACT", "Patch path is not a JSON Pointer.");
  }
  if (/~(?:[^01]|$)/u.test(path)) {
    throw new TraceDataError("INVALID_ARTIFACT", "Patch path contains an invalid JSON Pointer escape.");
  }
  return path.slice(1).split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function isDangerousSegment(segment: string): boolean {
  return ["__proto__", "constructor", "prototype"].includes(segment);
}

type MutableContainer = Record<string, JsonValue> | JsonValue[];

function childFromContainer(container: MutableContainer, segment: string): JsonValue {
  if (Array.isArray(container)) {
    const index = arrayIndex(segment, container.length - 1);
    return container[index] ?? null;
  }
  if (!Object.hasOwn(container, segment)) {
    throw new TraceDataError("INVALID_ARTIFACT", "Patch parent path does not exist.");
  }
  return container[segment] ?? null;
}

function mutableContainer(value: JsonValue): MutableContainer {
  if (Array.isArray(value) || isRecord(value)) {
    return value;
  }
  throw new TraceDataError("INVALID_ARTIFACT", "Patch path crosses a primitive value.");
}

function arrayIndex(segment: string, maximum: number): number {
  const index = Number.parseInt(segment, 10);
  if (!Number.isInteger(index) || String(index) !== segment || index < 0 || index > maximum) {
    throw new TraceDataError("INVALID_ARTIFACT", "Patch path contains an invalid array index.");
  }
  return index;
}

function parentAt(root: JsonValue, segments: readonly string[]): { parent: MutableContainer; key: string } {
  const key = segments.at(-1);
  if (key === undefined || isDangerousSegment(key)) {
    throw new TraceDataError("INVALID_ARTIFACT", "Patch path contains an unsafe segment.");
  }
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (isDangerousSegment(segment)) {
      throw new TraceDataError("INVALID_ARTIFACT", "Patch path contains an unsafe segment.");
    }
    current = childFromContainer(mutableContainer(current), segment);
  }
  return { parent: mutableContainer(current), key };
}

function applyArrayOperation(parent: JsonValue[], key: string, operation: StatePatchOperation): void {
  const maximum = operation.op === "add" ? parent.length : parent.length - 1;
  const index = arrayIndex(key, maximum);
  if (operation.op === "remove") {
    parent.splice(index, 1);
    return;
  }
  if (operation.op === "add") {
    parent.splice(index, 0, operation.value);
    return;
  }
  parent[index] = operation.value;
}

function applyRecordOperation(
  parent: Record<string, JsonValue>,
  key: string,
  operation: StatePatchOperation,
): void {
  const exists = Object.hasOwn(parent, key);
  if ((operation.op === "remove" || operation.op === "replace") && !exists) {
    throw new TraceDataError("INVALID_ARTIFACT", "Patch target path does not exist.");
  }
  if (operation.op === "add" && exists) {
    throw new TraceDataError("INVALID_ARTIFACT", "Patch addition path already exists.");
  }
  if (operation.op === "remove") {
    Reflect.deleteProperty(parent, key);
    return;
  }
  parent[key] = operation.value;
}

function applyOperation(root: JsonValue, operation: StatePatchOperation): JsonValue {
  const segments = decodePointer(operation.path);
  if (segments.length === 0) {
    if (operation.op === "remove") {
      throw new TraceDataError("INVALID_ARTIFACT", "The root state cannot be removed.");
    }
    return operation.value;
  }
  const { parent, key } = parentAt(root, segments);
  if (Array.isArray(parent)) {
    applyArrayOperation(parent, key, operation);
  } else {
    applyRecordOperation(parent, key, operation);
  }
  return root;
}

export function applyStatePatch(value: unknown, operations: readonly StatePatchOperation[]): JsonValue {
  let root = canonicalizeState(value).value;
  for (const operation of operations) {
    root = applyOperation(root, operation);
  }
  return canonicalizeState(root).value;
}
