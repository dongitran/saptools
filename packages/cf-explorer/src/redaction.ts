import type { ExplorerCredentials } from "./types.js";

export interface RedactionRule {
  readonly value: string;
  readonly replacement: string;
}

export function buildRedactionRules(
  credentials?: ExplorerCredentials,
  extras: readonly string[] = [],
): readonly RedactionRule[] {
  const values = [
    credentials?.email ?? "",
    credentials?.password ?? "",
    ...extras,
  ];
  const unique = new Set<string>();
  const rules: RedactionRule[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || unique.has(trimmed)) {
      continue;
    }
    unique.add(trimmed);
    rules.push({ value: trimmed, replacement: "[REDACTED]" });
  }

  return rules;
}

export function redactText(text: string, rules: readonly RedactionRule[]): string {
  return rules.reduce((current, rule) => current.split(rule.value).join(rule.replacement), text);
}
