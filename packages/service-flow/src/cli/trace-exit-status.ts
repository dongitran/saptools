import { selectorDiagnosticCodes } from
  '../trace/compact-field-projection.js';

const NON_REFUSAL_SELECTOR_DIAGNOSTICS = new Set([
  'handler_decorators_not_indexed',
  'handler_methods_not_indexed',
]);

export function traceStartRefused(
  diagnostics: ReadonlyArray<Record<string, unknown>>,
): boolean {
  return diagnostics.some((diagnostic) => {
    const code = String(diagnostic.code);
    return selectorDiagnosticCodes.has(code)
      && !NON_REFUSAL_SELECTOR_DIAGNOSTICS.has(code);
  });
}
