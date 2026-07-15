import { isAssociationElement, resolveTarget } from "./targets.js";
import type { HanaLensCsn, HanaLensDefinition, HanaLensElement } from "./types.js";

const MAX_EXPAND_DEPTH = 2;

type HanaLensTypeNode = HanaLensDefinition | HanaLensElement;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatEnum(element: HanaLensTypeNode): string {
  const enumValue = element.enum;
  if (enumValue === undefined) {
    return "";
  }
  const members = Object.entries(enumValue).map(([key, member]) => {
    const value = isRecord(member) ? member["val"] : undefined;
    if (value === undefined || value === key) {
      return key;
    }
    return `${key} = ${formatUnknownExpressionNode(value)}`;
  });
  return members.length === 0 ? "" : ` enum[${members.join(", ")}]`;
}

function typeParams(element: HanaLensTypeNode): string {
  if (element.length !== undefined) {
    return `(${element.length.toString()})`;
  }
  if (element.precision === undefined) {
    return "";
  }
  return element.scale === undefined
    ? `(${element.precision.toString()})`
    : `(${element.precision.toString()}, ${element.scale.toString()})`;
}

function typeText(element: HanaLensTypeNode): string {
  if (element.type === undefined && isRecord(element.items)) {
    return `array of ${typeText(element.items)}`;
  }
  if (element.type === undefined && isRecord(element.elements)) {
    return `{ ${Object.keys(element.elements).join(", ")} }`;
  }
  const base = element.type ?? "unknown";
  return `${base}${typeParams(element)}${formatEnum(element)}`;
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

function typeTextWithCondition(element: HanaLensTypeNode): string {
  const text = typeText(element);
  const target = element.target;
  const isAssociation = element.type === "cds.Association" || element.type === "cds.Composition";
  if (!isAssociation || typeof target !== "string") {
    return text;
  }
  const maximum = element.cardinality?.max;
  const many = maximum === "*" || Number(maximum) > 1 ? "many " : "";
  const condition = Array.isArray(element.on) && element.on.length > 0
    ? ` ON [${formatCsnExpression(element.on)}]`
    : "";
  return `${text} to ${many}${target}${condition}`;
}

function isPrimary(element: HanaLensElement): boolean {
  return element.key === true;
}

function formatElement(name: string, element: HanaLensElement, depth: number, withAnnotations: boolean): string {
  const prefix = depth === 0 ? "" : `${"-".repeat(depth)} `;
  const marker = `${isPrimary(element) ? "[PK] " : ""}${element["@Core.Computed"] === true ? "[computed] " : ""}`;
  return `${prefix}${marker}${name}: ${typeTextWithCondition(element)}${formatAnnotations(element, withAnnotations)}`;
}

function nestedPrefix(depth: number): string {
  return `${"-".repeat(depth + 1)} `;
}

function describeOperation(definition: HanaLensDefinition): readonly string[] {
  const lines = [`(${definition.kind ?? "operation"})`];
  const params = definition.params;
  if (isRecord(params)) {
    for (const [name, parameter] of Object.entries(params)) {
      if (isRecord(parameter)) {
        lines.push(`- param ${name}: ${typeTextWithCondition(parameter)}`);
      }
    }
  }
  const returns = definition.returns;
  if (isRecord(returns)) {
    lines.push(`- returns: ${typeTextWithCondition(returns)}`);
  }
  return lines;
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
  if (elements === undefined || Object.keys(elements).length === 0) {
    if (isRecord(definition.enum)) {
      const base = definition.type ?? "enum";
      const formattedEnum = formatEnum(definition);
      return [`${base}${formattedEnum === "" ? " enum[]" : formattedEnum}`];
    }
    if (definition.type !== undefined || definition.items !== undefined) {
      return [typeTextWithCondition(definition)];
    }
    if (definition.kind === "action" || definition.kind === "function") {
      return describeOperation(definition);
    }
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
