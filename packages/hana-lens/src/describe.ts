import { findPreferredTargetCandidates, isAssociationElement, resolveTarget } from "./targets.js";
import { PACKAGE_ANNOTATION } from "./types.js";
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

// Single-quoted, matching SQL/CQL string-literal syntax -- double quotes denote an
// identifier there, so a double-quoted literal copied into HANA would read as a column.
function formatStringLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function formatExpressionValue(value: unknown): string {
  if (typeof value === "string") {
    return formatStringLiteral(value);
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
    const rawArgs = token["args"];
    const args = Array.isArray(rawArgs)
      ? formatExpressionArguments(rawArgs)
      : isRecord(rawArgs)
        ? Object.entries(rawArgs).map(([argName, argValue]) => `${argName} => ${formatCsnExpressionToken(argValue)}`).join(", ")
        : "";
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

function formatAnnotations(source: unknown, withAnnotations: boolean): string {
  if (!withAnnotations || !isRecord(source)) {
    return "";
  }
  const annotations = Object.entries(source)
    // hana-lens's own bookkeeping, not a CSN annotation from the model -- it must never appear
    // alongside real @-annotations in --with-annotations output.
    .filter(([key]) => key.startsWith("@") && key !== PACKAGE_ANNOTATION)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${formatAnnotationValue(value)}`);
  return annotations.length === 0 ? "" : ` ${annotations.join(" ")}`;
}

function typeTextWithCondition(element: HanaLensTypeNode): string {
  const text = typeText(element);
  const isAssociation = element.type === "cds.Association" || element.type === "cds.Composition";
  if (!isAssociation) {
    return text;
  }
  const maximum = element.cardinality?.max;
  const many = maximum === "*" || Number(maximum) > 1 ? "many " : "";
  const condition = Array.isArray(element.on) && element.on.length > 0
    ? ` ON [${formatCsnExpression(element.on)}]`
    : "";
  const target = element.target;
  if (typeof target === "string") {
    return `${text} to ${many}${target}${condition}`;
  }
  // An inline/anonymous aspect target (`Composition of many { ... }`) has no named target at
  // all -- its shape lives in targetAspect instead, matching the same anonymous-struct rendering
  // typeText already uses for a plain `{ elements }` node with no type.
  const targetAspect = element.targetAspect;
  if (isRecord(targetAspect) && isRecord(targetAspect["elements"])) {
    return `${text} to ${many}{ ${Object.keys(targetAspect["elements"]).join(", ")} }${condition}`;
  }
  return text;
}

function isPrimary(element: HanaLensElement): boolean {
  return element.key === true;
}

function linePrefix(depth: number): string {
  return depth === 0 ? "" : `${"-".repeat(depth)} `;
}

function nestedPrefix(depth: number): string {
  return `${"-".repeat(depth + 1)} `;
}

function formatElement(name: string, element: HanaLensElement, depth: number, withAnnotations: boolean): string {
  const markers = [
    isPrimary(element) ? "[PK] " : "",
    element["@Core.Computed"] === true ? "[computed] " : "",
    element.virtual === true ? "[virtual] " : "",
    element.notNull === true ? "[not null] " : "",
    element.localized === true ? "[localized] " : "",
  ];
  const marker = markers.join("");
  return `${linePrefix(depth)}${marker}${name}: ${typeTextWithCondition(element)}${formatAnnotations(element, withAnnotations)}`;
}

function describeParams(params: HanaLensDefinition["params"], depth: number): readonly string[] {
  if (!isRecord(params)) {
    return [];
  }
  return Object.entries(params)
    .filter((entry): entry is [string, HanaLensElement] => isRecord(entry[1]))
    .map(([name, parameter]) => `${linePrefix(depth)}- param ${name}: ${typeTextWithCondition(parameter)}`);
}

function describeOperation(definition: HanaLensDefinition, depth: number, label?: string): readonly string[] {
  const labelPrefix = label === undefined ? "" : `${label}: `;
  const lines = [`${linePrefix(depth)}${labelPrefix}(${definition.kind ?? "operation"})`, ...describeParams(definition.params, depth)];
  const returns = definition.returns;
  if (isRecord(returns)) {
    lines.push(`${linePrefix(depth)}- returns: ${typeTextWithCondition(returns)}`);
  }
  return lines;
}

function describeAnnotationHeader(definition: HanaLensDefinition, withAnnotations: boolean, depth: number): readonly string[] {
  const rendered = formatAnnotations(definition, withAnnotations).trim();
  return rendered.length === 0 ? [] : [`${linePrefix(depth)}${rendered}`];
}

function describeExpandedTarget(csn: HanaLensCsn, definition: HanaLensDefinition, element: HanaLensElement, expand: boolean, withAnnotations: boolean, depth: number, seen: ReadonlySet<string>): readonly string[] {
  if (!expand || element.target === undefined || !isAssociationElement(element)) {
    return [];
  }

  const resolution = resolveTarget(csn, element.target, definition);
  if (resolution.status === "missing") {
    return [`${nestedPrefix(depth)}${element.target}: missing`];
  }
  if (resolution.status === "ambiguous") {
    return [`${nestedPrefix(depth)}${element.target}: ambiguous`];
  }
  // Checked before the depth limit: a cycle closing exactly at the boundary is a real structural
  // fact about the model that must never be masked as mere truncation.
  if (seen.has(resolution.target.name)) {
    return [`${nestedPrefix(depth)}${resolution.target.name}: circular`];
  }
  if (depth >= MAX_EXPAND_DEPTH) {
    return [`${nestedPrefix(depth)}${resolution.target.name}: truncated`];
  }

  const nextSeen = new Set(seen);
  nextSeen.add(resolution.target.name);
  return describeDefinition(csn, resolution.target.definition, expand, withAnnotations, depth + 1, nextSeen, resolution.target.name);
}

function describeDefinition(
  csn: HanaLensCsn,
  definition: HanaLensDefinition,
  expand: boolean,
  withAnnotations: boolean,
  depth: number,
  seen: ReadonlySet<string>,
  label?: string,
): readonly string[] {
  const header = describeAnnotationHeader(definition, withAnnotations, depth);
  const labelPrefix = label === undefined ? "" : `${label}: `;
  const elements = definition.elements;
  if (elements === undefined || Object.keys(elements).length === 0) {
    if (isRecord(definition.enum)) {
      const base = definition.type ?? "enum";
      const formattedEnum = formatEnum(definition);
      return [...header, `${linePrefix(depth)}${labelPrefix}${base}${formattedEnum === "" ? " enum[]" : formattedEnum}`];
    }
    if (definition.type !== undefined || definition.items !== undefined) {
      return [...header, `${linePrefix(depth)}${labelPrefix}${typeTextWithCondition(definition)}`];
    }
    if (definition.kind === "action" || definition.kind === "function") {
      return [...header, ...describeOperation(definition, depth, label)];
    }
    const paramLines = describeParams(definition.params, depth);
    return paramLines.length > 0
      ? [...header, ...paramLines]
      : [...header, `${linePrefix(depth)}${labelPrefix}(no elements)`];
  }
  const lines: string[] = [...header, ...describeParams(definition.params, depth)];
  for (const [name, element] of Object.entries(elements)) {
    lines.push(formatElement(name, element, depth, withAnnotations), ...describeExpandedTarget(csn, definition, element, expand, withAnnotations, depth, seen));
  }
  return lines;
}

export function describeEntity(csn: HanaLensCsn, entityName: string, expand: boolean, withAnnotations = false): string {
  const candidates = findPreferredTargetCandidates(csn, entityName);
  if (candidates.length === 0) {
    throw new Error(`Entity not found: ${entityName}`);
  }
  if (candidates.length > 1) {
    const names = candidates.map((candidate) => candidate.name).sort((left, right) => left.localeCompare(right));
    const shown = names.slice(0, 5);
    const remaining = names.length - shown.length;
    const suffix = remaining > 0 ? `, ... (+${remaining.toString()} more)` : "";
    throw new Error(
      `Ambiguous name ${JSON.stringify(entityName)} matches ${names.length.toString()} definitions: `
      + `${shown.join(", ")}${suffix}; specify the full name.`,
    );
  }
  const candidate = candidates[0];
  if (candidate === undefined) {
    throw new Error(`Entity not found: ${entityName}`);
  }
  return describeDefinition(
    csn,
    candidate.definition,
    expand,
    withAnnotations,
    0,
    new Set([candidate.name]),
  ).join("\n");
}
