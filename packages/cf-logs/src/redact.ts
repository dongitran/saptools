import type { RedactionRule, RedactionSource } from "./types.js";

export function buildRedactionRules(source: RedactionSource): readonly RedactionRule[] {
  const values = [
    source.email ?? "",
    source.password ?? "",
    ...(source.secrets ?? []),
  ];
  const unique = new Set<string>();
  const rules: RedactionRule[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length === 0 || unique.has(normalized)) {
      continue;
    }
    unique.add(normalized);
    rules.push({ value: normalized, replacement: "***" });
  }

  return rules;
}

export function redactText(text: string, rules: readonly RedactionRule[]): string {
  let output = text;

  for (const rule of rules) {
    if (rule.value.length === 0) {
      continue;
    }
    output = output.split(rule.value).join(rule.replacement ?? "***");
  }

  return output;
}
