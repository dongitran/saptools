const ADF_RULE_SEPARATOR = "---";
const BULLET_LIST_MARKER = "-";
const LIST_NESTING_INDENT = "  ";
const MEDIA_PLACEHOLDER_FALLBACK_LABEL = "attachment";

type AdfListKind = "bullet" | "ordered";

export function extractTextFromAdf(value: unknown): string {
  return finalizeAdfText(renderAdfBlocks([value]));
}

function finalizeAdfText(blocks: readonly string[]): string {
  const meaningfulBlocks = blocks.filter((block) => block.trim().length > 0);
  const trimmedLines = meaningfulBlocks
    .join("\n\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n");
  return trimmedLines.replace(/\n{3,}/gu, "\n\n").trim();
}

function renderAdfBlocks(nodes: readonly unknown[]): string[] {
  return nodes.flatMap(renderAdfBlockNode);
}

function renderAdfBlockNode(node: unknown): string[] {
  if (!isRecord(node)) {
    return [];
  }

  switch (node["type"]) {
    case "heading":
    case "paragraph":
      return [renderInlineContent(toNodeArray(node["content"]))];
    case "bulletList":
      return [renderAdfList(node, "bullet", 0).join("\n")];
    case "orderedList":
      return [renderAdfList(node, "ordered", 0).join("\n")];
    case "rule":
      return [ADF_RULE_SEPARATOR];
    case "media":
    case "mediaSingle":
      return [renderMediaPlaceholder(node)];
    default:
      return renderAdfFallbackBlock(node);
  }
}

function renderAdfFallbackBlock(node: Record<string, unknown>): string[] {
  const textPart = typeof node["text"] === "string" ? [node["text"]] : [];
  const contentPart = Array.isArray(node["content"]) ? renderAdfBlocks(node["content"]) : [];
  return [...textPart, ...contentPart];
}

function renderAdfList(node: Record<string, unknown>, kind: AdfListKind, depth: number): string[] {
  const items = toNodeArray(node["content"]).filter(isAdfListItem);
  const start = kind === "ordered" ? resolveOrderedListStart(node) : 1;
  return items.flatMap((item, index) => renderAdfListItem(item, kind, depth, start + index));
}

function resolveOrderedListStart(node: Record<string, unknown>): number {
  const attrs = resolveAdfNodeAttrs(node);
  const order = attrs?.["order"];
  return typeof order === "number" && Number.isInteger(order) && order > 0 ? order : 1;
}

function renderAdfListItem(
  item: Record<string, unknown>,
  kind: AdfListKind,
  depth: number,
  ordinal: number,
): string[] {
  const children = toNodeArray(item["content"]);
  const nestedLists = children.filter(isAdfListNode);
  const ownChildren = children.filter((child) => !isAdfListNode(child));
  const marker = kind === "ordered" ? `${ordinal.toString()}.` : BULLET_LIST_MARKER;
  const indent = LIST_NESTING_INDENT.repeat(depth);
  const firstLine = `${indent}${marker} ${renderInlineContent(ownChildren)}`.replace(/[ \t]+$/u, "");
  const nestedLines = nestedLists.flatMap((nested) =>
    renderAdfList(nested, nested["type"] === "orderedList" ? "ordered" : "bullet", depth + 1),
  );
  return [firstLine, ...nestedLines];
}

function isAdfListItem(node: unknown): node is Record<string, unknown> {
  return isRecord(node) && node["type"] === "listItem";
}

function isAdfListNode(node: unknown): node is Record<string, unknown> {
  return isRecord(node) && (node["type"] === "bulletList" || node["type"] === "orderedList");
}

function renderInlineContent(nodes: readonly unknown[]): string {
  return collapseInlineWhitespace(nodes.map(renderInlineNode).join(""));
}

function collapseInlineWhitespace(value: string): string {
  return value.replace(/[ \t]+/gu, " ");
}

function renderInlineNode(node: unknown): string {
  if (!isRecord(node)) {
    return "";
  }
  if (node["type"] === "hardBreak") {
    return "\n";
  }
  if (node["type"] === "media" || node["type"] === "mediaSingle") {
    return renderMediaPlaceholder(node);
  }

  const textPart = typeof node["text"] === "string" ? node["text"] : "";
  const contentPart = Array.isArray(node["content"]) ? renderInlineContent(node["content"]) : "";
  return textPart + contentPart;
}

function renderMediaPlaceholder(node: Record<string, unknown>): string {
  const attrs = resolveAdfNodeAttrs(resolveAdfMediaNode(node));
  const label =
    firstNonBlankString(attrs?.["alt"]) ?? firstNonBlankString(attrs?.["id"]) ?? MEDIA_PLACEHOLDER_FALLBACK_LABEL;
  return `[image: ${label}]`;
}

function resolveAdfMediaNode(node: Record<string, unknown>): Record<string, unknown> | null {
  if (node["type"] === "media") {
    return node;
  }
  const media = toNodeArray(node["content"]).find((child) => isRecord(child) && child["type"] === "media");
  return isRecord(media) ? media : null;
}

function resolveAdfNodeAttrs(node: Record<string, unknown> | null): Record<string, unknown> | null {
  if (node === null) {
    return null;
  }
  return isRecord(node["attrs"]) ? node["attrs"] : null;
}

function firstNonBlankString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function toNodeArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
