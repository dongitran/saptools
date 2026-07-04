import { isAssociationElement, resolveTarget } from "./targets.js";
import type { HanaLensCsn, HanaLensDefinition, HanaLensElement } from "./types.js";

const MAX_EXPAND_DEPTH = 2;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatEnum(element: HanaLensElement): string {
  const enumValue = element.enum;
  if (enumValue === undefined) {
    return "";
  }
  const keys = Object.keys(enumValue);
  return keys.length === 0 ? "" : ` enum[${keys.join(", ")}]`;
}

function typeText(element: HanaLensElement): string {
  const base = element.type ?? "unknown";
  const text = element.length === undefined ? base : `${base}(${element.length.toString()})`;
  return `${text}${formatEnum(element)}`;
}

function formatUnknownExpressionNode(node: unknown): string {
  if (node === undefined || typeof node === "function" || typeof node === "symbol") {
    return String(node);
  }
  if (typeof node === "bigint") {
    return node.toString();
  }
  try {
    const serialized: unknown = JSON.stringify(node);
    return typeof serialized === "string" ? serialized : "[unserializable]";
  } catch {
    return "[unserializable]";
  }
}

function formatExpressionRefSegment(segment: unknown): string {
  if (typeof segment === "string") {
    return segment;
  }
  if (isRecord(segment) && typeof segment["id"] === "string") {
    const where = Array.isArray(segment["where"]) ? `[${formatCsnExpression(segment["where"])}]` : "";
    return `${segment["id"]}${where}`;
  }
  return formatUnknownExpressionNode(segment);
}

function formatExpressionRef(ref: readonly unknown[]): string {
  return ref.map(formatExpressionRefSegment).join(".");
}

function formatExpressionValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || value === null) {
    return String(value);
  }
  return formatUnknownExpressionNode(value);
}

function formatExpressionArguments(args: readonly unknown[]): string {
  return args.map((arg) => Array.isArray(arg) ? formatCsnExpression(arg) : formatCsnExpressionToken(arg)).join(", ");
}

function formatCsnExpressionToken(token: unknown): string {
  if (typeof token === "string") {
    return token;
  }
  if (Array.isArray(token)) {
    return `(${formatCsnExpression(token)})`;
  }
  if (!isRecord(token)) {
    return formatUnknownExpressionNode(token);
  }
  if (Array.isArray(token["ref"])) {
    return formatExpressionRef(token["ref"]);
  }
  if ("val" in token) {
    return formatExpressionValue(token["val"]);
  }
  if (Array.isArray(token["xpr"])) {
    return `(${formatCsnExpression(token["xpr"])})`;
  }
  if (typeof token["func"] === "string") {
    const args = Array.isArray(token["args"]) ? formatExpressionArguments(token["args"]) : "";
    return `${token["func"]}(${args})`;
  }
  if (Array.isArray(token["list"])) {
    return `(${formatExpressionArguments(token["list"])})`;
  }
  return formatUnknownExpressionNode(token);
}

export function formatCsnExpression(expression: readonly unknown[]): string {
  return expression.map(formatCsnExpressionToken).join(" ");
}

function formatAnnotationValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || value === null) {
    return String(value);
  }
  return formatUnknownExpressionNode(value);
}

function formatAnnotations(element: HanaLensElement, withAnnotations: boolean): string {
  if (!withAnnotations) {
    return "";
  }
  const annotations = Object.entries(element)
    .filter(([key]) => key.startsWith("@"))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${formatAnnotationValue(value)}`);
  return annotations.length === 0 ? "" : ` ${annotations.join(" ")}`;
}

function typeTextWithCondition(element: HanaLensElement): string {
  const text = typeText(element);
  if (!isAssociationElement(element) || element.on === undefined || element.on.length === 0) {
    return text;
  }
  return `${text} ON [${formatCsnExpression(element.on)}]`;
}

function isPrimary(element: HanaLensElement): boolean {
  return element.key === true || element["@Core.Computed"] === true;
}

function formatElement(name: string, element: HanaLensElement, depth: number, withAnnotations: boolean): string {
  const prefix = depth === 0 ? "" : `${"-".repeat(depth)} `;
  const marker = isPrimary(element) ? "[PK] " : "";
  return `${prefix}${marker}${name}: ${typeTextWithCondition(element)}${formatAnnotations(element, withAnnotations)}`;
}

function nestedPrefix(depth: number): string {
  return `${"-".repeat(depth + 1)} `;
}

function describeExpandedTarget(csn: HanaLensCsn, definition: HanaLensDefinition, element: HanaLensElement, expand: boolean, withAnnotations: boolean, depth: number, seen: ReadonlySet<string>): readonly string[] {
  if (!expand || depth >= MAX_EXPAND_DEPTH || element.target === undefined || !isAssociationElement(element)) {
    return [];
  }

  const resolution = resolveTarget(csn, element.target, definition);
  if (resolution.status === "missing") {
    return [`${nestedPrefix(depth)}${element.target}: missing`];
  }
  if (resolution.status === "ambiguous") {
    return [`${nestedPrefix(depth)}${element.target}: ambiguous`];
  }
  if (seen.has(resolution.target.name)) {
    return [`${nestedPrefix(depth)}${resolution.target.name}: circular`];
  }

  const nextSeen = new Set(seen);
  nextSeen.add(resolution.target.name);
  return describeDefinition(csn, resolution.target.definition, expand, withAnnotations, depth + 1, nextSeen);
}

function describeDefinition(csn: HanaLensCsn, definition: HanaLensDefinition, expand: boolean, withAnnotations: boolean, depth: number, seen: ReadonlySet<string>): readonly string[] {
  const elements = definition.elements;
  if (elements === undefined) {
    return ["(no elements)"];
  }
  const lines: string[] = [];
  for (const [name, element] of Object.entries(elements)) {
    lines.push(formatElement(name, element, depth, withAnnotations), ...describeExpandedTarget(csn, definition, element, expand, withAnnotations, depth, seen));
  }
  return lines;
}

export function describeEntity(csn: HanaLensCsn, entityName: string, expand: boolean, withAnnotations = false): string {
  const definition = csn.definitions[entityName];
  if (definition === undefined) {
    throw new Error(`Entity not found: ${entityName}`);
  }
  return describeDefinition(csn, definition, expand, withAnnotations, 0, new Set([entityName])).join("\n");
}
