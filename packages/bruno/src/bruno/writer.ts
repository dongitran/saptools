import { listBlocks, parseKeyValueBody } from "./parser.js";

export interface UpsertResult {
  readonly content: string;
  readonly changed: boolean;
}

function formatVarsBlock(entries: ReadonlyMap<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of entries) {
    lines.push(`  ${key}: ${value}`);
  }
  return lines.join("\n");
}

export function upsertVars(
  raw: string,
  updates: ReadonlyMap<string, string>,
): UpsertResult {
  const blocks = listBlocks(raw);
  const varsBlock = blocks.find((b) => b.header === "vars" && b.open === "{");

  if (!varsBlock) {
    const newBlock = `vars {\n${formatVarsBlock(updates)}\n}\n`;
    const sep = raw.length > 0 && !raw.endsWith("\n") ? "\n\n" : raw.length > 0 ? "\n" : "";
    return { content: `${raw}${sep}${newBlock}`, changed: updates.size > 0 };
  }

  const body = raw.slice(varsBlock.bodyStart, varsBlock.bodyEnd);
  const existing = parseKeyValueBody(body);
  let changed = false;
  for (const [k, v] of updates) {
    if (existing.get(k) !== v) {
      existing.set(k, v);
      changed = true;
    }
  }

  if (!changed) {
    return { content: raw, changed: false };
  }

  const rebuilt = `\n${formatVarsBlock(existing)}\n`;
  const before = raw.slice(0, varsBlock.bodyStart);
  const after = raw.slice(varsBlock.bodyEnd);
  return { content: `${before}${rebuilt}${after}`, changed: true };
}

export function ensureSecretEntry(raw: string, secretName: string): UpsertResult {
  const blocks = listBlocks(raw);
  const secretsBlock = blocks.find((b) => b.header === "vars:secret" && b.open === "[");

  if (!secretsBlock) {
    const newBlock = `vars:secret [\n  ${secretName}\n]\n`;
    const sep = raw.length > 0 && !raw.endsWith("\n") ? "\n\n" : raw.length > 0 ? "\n" : "";
    return { content: `${raw}${sep}${newBlock}`, changed: true };
  }

  const body = raw.slice(secretsBlock.bodyStart, secretsBlock.bodyEnd);
  const items = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//"));
  if (items.includes(secretName)) {
    return { content: raw, changed: false };
  }
  items.push(secretName);
  const rebuilt = `\n  ${items.join("\n  ")}\n`;
  const before = raw.slice(0, secretsBlock.bodyStart);
  const after = raw.slice(secretsBlock.bodyEnd);
  return { content: `${before}${rebuilt}${after}`, changed: true };
}
