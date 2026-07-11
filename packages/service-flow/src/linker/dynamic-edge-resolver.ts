export interface RuntimeSubstitution {
  original?: string;
  effective?: string;
  placeholders: string[];
  missing: string[];
  supplied: string[];
  changed: boolean;
}

const PLACEHOLDER = /\$\{([^}]*)\}/g;

export function applyVariables(
  template: string | undefined,
  vars: Record<string, string>,
): string | undefined {
  return substituteVariables(template, vars).effective;
}

export function extractPlaceholders(template: string | undefined): string[] {
  return [...(template ?? '').matchAll(PLACEHOLDER)]
    .map((m) => (m[1] ?? '').trim())
    .filter(Boolean);
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
  const effective = template.replace(PLACEHOLDER, (_m, key: string) => {
    const trimmed = key.trim();
    return Object.hasOwn(vars, trimmed) ? vars[trimmed] ?? '' : `\${${trimmed}}`;
  });
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
  for (const match of template.matchAll(PLACEHOLDER)) {
    pattern += escapeRegex(template.slice(lastIndex, match.index));
    pattern += '([^/]+?)';
    lastIndex = (match.index ?? 0) + match[0].length;
  }
  return `${pattern}${escapeRegex(template.slice(lastIndex))}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
