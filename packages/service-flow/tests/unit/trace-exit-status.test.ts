import { describe, expect, it } from 'vitest';
import { traceStartRefused } from '../../src/cli/trace-exit-status.js';

describe('trace exit status', () => {
  it.each([
    'trace_start_ambiguous',
    'trace_start_not_found',
    'trace_start_implementation_unresolved',
    'selector_repo_ambiguous',
    'selector_repo_not_found',
  ])('treats %s as a refused start', (code) => {
    expect(traceStartRefused([{ code }])).toBe(true);
  });

  it.each([
    'handler_methods_not_indexed',
    'handler_decorators_not_indexed',
    'trace_runtime_variables_missing',
    'event_shape_candidates_hidden',
    'external_package_calls_omitted',
  ])('keeps %s informational for command status', (code) => {
    expect(traceStartRefused([{ code }])).toBe(false);
  });
});
