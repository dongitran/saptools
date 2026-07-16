import { extractPlaceholderKeys, scanPlaceholders } from '../utils/001-placeholders.js';

export interface RuntimeSubstitution {
  original?: string;
  effective?: string;
  placeholders: string[];
  missing: string[];
  supplied: string[];
  changed: boolean;
}

export function applyVariables(
  template: string | undefined,
  vars: Record<string, string>,
): string | undefined {
  return substituteVariables(template, vars).effective;
}

export function extractPlaceholders(template: string | undefined): string[] {
  return extractPlaceholderKeys(template);
}

export function matchRuntimeTemplate(
  template: string | undefined,
  concrete: string | undefined,
): Record<string, string> | undefined {
  if (!template || !concrete) return undefined;
  const keys = extractPlaceholders(template);
  if (keys.length === 0) return template === concrete ? {} : undefined;
  const match = new RegExp(`^${runtimeTemplatePattern(template)}$`).exec(concrete);
  if (!match) return undefined;
  const values: Record<string, string> = {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const value = match[index + 1];
    if (!key || value === undefined) return undefined;
    if (values[key] !== undefined && values[key] !== value) return undefined;
    values[key] = value;
  }
  return values;
}

export function substituteVariables(
  template: string | undefined,
  vars: Record<string, string>,
): RuntimeSubstitution {
  if (!template) return { placeholders: [], missing: [], supplied: [], changed: false };
  const placeholders = [...new Set(extractPlaceholders(template))];
  const supplied = placeholders.filter((key) => Object.hasOwn(vars, key));
  const missing = placeholders.filter((key) => !Object.hasOwn(vars, key));
  let lastIndex = 0;
  let effective = '';
  for (const span of scanPlaceholders(template)) {
    const trimmed = span.key.trim();
    const replacement = Object.hasOwn(vars, trimmed) ? vars[trimmed] ?? '' : `\${${trimmed}}`;
    effective += template.slice(lastIndex, span.start) + replacement;
    lastIndex = span.end;
  }
  effective += template.slice(lastIndex);
  return {
    original: template,
    effective,
    placeholders,
    missing,
    supplied,
    changed: effective !== template,
  };
}

function runtimeTemplatePattern(template: string): string {
  let pattern = '';
  let lastIndex = 0;
  for (const span of scanPlaceholders(template)) {
    pattern += escapeRegex(template.slice(lastIndex, span.start));
    pattern += '([^/]+?)';
    lastIndex = span.end;
  }
  return `${pattern}${escapeRegex(template.slice(lastIndex))}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
