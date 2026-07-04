import { PACKAGE_ANNOTATION, type HanaLensCsn, type HanaLensDefinition, type HanaLensElement } from "./types.js";

const ASSOCIATION_TYPES = new Set(["cds.Association", "cds.Composition"]);
const MAX_EXPAND_DEPTH = 2;

interface ResolvedTarget {
  readonly name: string;
  readonly definition: HanaLensDefinition;
}

type TargetResolution =
  | { readonly status: "resolved"; readonly target: ResolvedTarget }
  | { readonly status: "missing" }
  | { readonly status: "ambiguous" };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeText(element: HanaLensElement): string {
  const base = element.type ?? "unknown";
  return element.length === undefined ? base : `${base}(${element.length.toString()})`;
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

function typeTextWithCondition(element: HanaLensElement): string {
  const text = typeText(element);
  if (!ASSOCIATION_TYPES.has(element.type ?? "") || element.on === undefined || element.on.length === 0) {
    return text;
  }
  return `${text} ON [${formatCsnExpression(element.on)}]`;
}

function isPrimary(element: HanaLensElement): boolean {
  return element.key === true || element["@Core.Computed"] === true;
}

function formatElement(name: string, element: HanaLensElement, depth: number): string {
  const prefix = depth === 0 ? "" : `${"-".repeat(depth)} `;
  const marker = isPrimary(element) ? "[PK] " : "";
  return `${prefix}${marker}${name}: ${typeTextWithCondition(element)}`;
}

function nestedPrefix(depth: number): string {
  return `${"-".repeat(depth + 1)} `;
}

function packageNameOf(definition: HanaLensDefinition): string | undefined {
  return definition[PACKAGE_ANNOTATION];
}

function isTargetNameMatch(definitionName: string, targetName: string): boolean {
  return definitionName === targetName || definitionName.endsWith(`.${targetName}`);
}

function findTargetCandidates(csn: HanaLensCsn, targetName: string): readonly ResolvedTarget[] {
  return Object.entries(csn.definitions)
    .filter(([definitionName]) => isTargetNameMatch(definitionName, targetName))
    .map(([name, definition]) => ({ name, definition }));
}

function resolved(target: ResolvedTarget): TargetResolution {
  return { status: "resolved", target };
}

function singleCandidate(candidates: readonly ResolvedTarget[]): ResolvedTarget | undefined {
  const [candidate, ...rest] = candidates;
  return candidate !== undefined && rest.length === 0 ? candidate : undefined;
}

function resolveTarget(csn: HanaLensCsn, targetName: string, sourceDefinition: HanaLensDefinition): TargetResolution {
  const exact = csn.definitions[targetName];
  if (exact !== undefined) {
    return resolved({ name: targetName, definition: exact });
  }

  const candidates = findTargetCandidates(csn, targetName);
  if (candidates.length === 0) {
    return { status: "missing" };
  }
  const onlyCandidate = singleCandidate(candidates);
  if (onlyCandidate !== undefined) {
    return resolved(onlyCandidate);
  }

  const sourcePackage = packageNameOf(sourceDefinition);
  if (sourcePackage === undefined) {
    return { status: "ambiguous" };
  }

  const samePackage = candidates.filter((candidate) => packageNameOf(candidate.definition) === sourcePackage);
  const onlySamePackage = singleCandidate(samePackage);
  return onlySamePackage === undefined ? { status: "ambiguous" } : resolved(onlySamePackage);
}

function describeExpandedTarget(csn: HanaLensCsn, definition: HanaLensDefinition, element: HanaLensElement, expand: boolean, depth: number, seen: ReadonlySet<string>): readonly string[] {
  if (!expand || depth >= MAX_EXPAND_DEPTH || element.target === undefined || !ASSOCIATION_TYPES.has(element.type ?? "")) {
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
  return describeDefinition(csn, resolution.target.definition, expand, depth + 1, nextSeen);
}

function describeDefinition(csn: HanaLensCsn, definition: HanaLensDefinition, expand: boolean, depth: number, seen: ReadonlySet<string>): readonly string[] {
  const elements = definition.elements;
  if (elements === undefined) {
    return ["(no elements)"];
  }
  const lines: string[] = [];
  for (const [name, element] of Object.entries(elements)) {
    lines.push(formatElement(name, element, depth), ...describeExpandedTarget(csn, definition, element, expand, depth, seen));
  }
  return lines;
}

export function describeEntity(csn: HanaLensCsn, entityName: string, expand: boolean): string {
  const definition = csn.definitions[entityName];
  if (definition === undefined) {
    throw new Error(`Entity not found: ${entityName}`);
  }
  return describeDefinition(csn, definition, expand, 0, new Set([entityName])).join("\n");
}
