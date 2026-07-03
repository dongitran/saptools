import type { TraceStart } from '../types.js';
export function parseVars(
  values: string[] | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values ?? []) {
    const [key, ...rest] = value.split('=');
    if (key && rest.length > 0) out[key] = rest.join('=');
  }
  return out;
}
export function startLabel(start: TraceStart): string {
  return [
    start.repo,
    start.servicePath,
    start.operation ?? start.operationPath ?? start.handler
  ]
    .filter(Boolean)
    .join(' ');
}
