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
export function ambiguousStartDiagnostic(
  requested: string,
  candidates: Array<Record<string, unknown>>,
  message: string,
): Record<string, unknown> {
  const serviceSuggestions = [...new Set(candidates
    .flatMap((row) => typeof row.servicePath === 'string'
      ? [`--service ${row.servicePath}`]
      : []))].sort();
  return {
    severity: 'warning',
    code: 'trace_start_ambiguous',
    message,
    normalizedSelectorValue: requested,
    resolutionStage: 'operation',
    resolutionStatus: 'ambiguous_operation',
    candidates,
    serviceSuggestions,
    selectorSuggestions: fullSelectorSuggestions(candidates),
  };
}
function fullSelectorSuggestions(
  candidates: Array<Record<string, unknown>>,
): string[] {
  const includeRepo = new Set(candidates.map((row) => row.repoName)).size > 1;
  return [...new Set(candidates.flatMap((row) => {
    if (typeof row.servicePath !== 'string'
      || typeof row.operationPath !== 'string') return [];
    const repoSelector = includeRepo && typeof row.repoName === 'string'
      ? `--repo ${row.repoName} `
      : '';
    return [
      `${repoSelector}--service ${row.servicePath} --path ${row.operationPath}`,
    ];
  }))].sort();
}
