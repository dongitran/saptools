const SENSITIVE = /authorization|cookie|token|secret|password|key|credential/i;
export function redactText(text: string): string {
  return text.replace(
    /(authorization|cookie|token|secret|password|key|credential)\s*[:=]\s*(['"`]?)[^,'"`}\s]+\2/gi,
    '$1: [REDACTED]'
  );
}
export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value))
      out[k] = SENSITIVE.test(k) ? '[REDACTED]' : redactValue(v);
    return out;
  }
  return typeof value === 'string' ? redactText(value) : value;
}
export function summarizeExpression(text: string): string {
  return redactText(text).slice(0, 240);
}
