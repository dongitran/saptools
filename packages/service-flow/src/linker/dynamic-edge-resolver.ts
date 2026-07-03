export interface RuntimeSubstitution {
  original?: string;
  effective?: string;
  placeholders: string[];
  missing: string[];
  supplied: string[];
  changed: boolean;
}

const PLACEHOLDER = /\$\{\s*(\w+)\s*\}/g;

export function applyVariables(
  template: string | undefined,
  vars: Record<string, string>,
): string | undefined {
  return substituteVariables(template, vars).effective;
}

export function extractPlaceholders(template: string | undefined): string[] {
  return [...(template ?? '').matchAll(PLACEHOLDER)]
    .map((m) => m[1] ?? '')
    .filter(Boolean);
}

export function substituteVariables(
  template: string | undefined,
  vars: Record<string, string>,
): RuntimeSubstitution {
  if (!template) return { placeholders: [], missing: [], supplied: [], changed: false };
  const placeholders = [...new Set(extractPlaceholders(template))];
  const supplied = placeholders.filter((key) => Object.hasOwn(vars, key));
  const missing = placeholders.filter((key) => !Object.hasOwn(vars, key));
  const effective = template.replace(PLACEHOLDER, (_m, key: string) =>
    Object.hasOwn(vars, key) ? vars[key] ?? '' : `\${${key}}`,
  );
  return {
    original: template,
    effective,
    placeholders,
    missing,
    supplied,
    changed: effective !== template,
  };
}
