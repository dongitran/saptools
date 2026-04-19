import type { BruVarsBlock } from "./types.js";

interface BlockRange {
  readonly header: string;
  readonly start: number;
  readonly end: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly open: "{" | "[";
  readonly close: "}" | "]";
}

const HEADER_REGEX = /(^|\n)[^\S\n]*([a-zA-Z][a-zA-Z0-9:_-]*)[^\S\n]*([{[])/g;

function findMatchingClose(raw: string, open: "{" | "[", openIdx: number): number {
  const close = open === "{" ? "}" : "]";
  let depth = 1;
  let i = openIdx + 1;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
    i++;
  }
  return -1;
}

export function listBlocks(raw: string): readonly BlockRange[] {
  const blocks: BlockRange[] = [];
  HEADER_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HEADER_REGEX.exec(raw)) !== null) {
    const leadingNewline = match[1] ?? "";
    const header = match[2];
    const open = match[3];
    if (header === undefined || (open !== "{" && open !== "[")) {
      continue;
    }
    const headerStart = match.index + leadingNewline.length;
    const openIdx = match.index + match[0].length - 1;
    const closeIdx = findMatchingClose(raw, open, openIdx);
    if (closeIdx === -1) {
      continue;
    }
    blocks.push({
      header,
      start: headerStart,
      end: closeIdx + 1,
      bodyStart: openIdx + 1,
      bodyEnd: closeIdx,
      open,
      close: open === "{" ? "}" : "]",
    });
  }
  return blocks;
}

export function parseKeyValueBody(body: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const lineRaw of body.split("\n")) {
    const line = lineRaw.trim();
    if (line.length === 0 || line.startsWith("//")) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key.length > 0) {
      entries.set(key, value);
    }
  }
  return entries;
}

export function parseListBody(body: string): string[] {
  const items: string[] = [];
  for (const lineRaw of body.split("\n")) {
    const line = lineRaw.trim();
    if (line.length === 0 || line.startsWith("//")) {
      continue;
    }
    items.push(line);
  }
  return items;
}

export interface ParsedBruEnv {
  readonly vars: BruVarsBlock;
  readonly secrets: readonly string[];
}

export function parseBruEnvFile(raw: string): ParsedBruEnv {
  const blocks = listBlocks(raw);
  const varsBlock = blocks.find((b) => b.header === "vars" && b.open === "{");
  const secretsBlock = blocks.find((b) => b.header === "vars:secret" && b.open === "[");

  const entries = varsBlock
    ? parseKeyValueBody(raw.slice(varsBlock.bodyStart, varsBlock.bodyEnd))
    : new Map<string, string>();
  const secrets = secretsBlock
    ? parseListBody(raw.slice(secretsBlock.bodyStart, secretsBlock.bodyEnd))
    : [];

  return { vars: { entries }, secrets };
}
