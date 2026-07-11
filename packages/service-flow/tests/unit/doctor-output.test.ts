import { describe, expect, it } from 'vitest';
import { renderDoctorDiagnostics, renderDoctorTable } from '../../src/output/doctor-output.js';

describe('doctor output rendering', () => {
  it('returns a deterministic empty JSON array in json format', () => {
    expect(renderDoctorDiagnostics([], 'json')).toBe('[]\n');
  });

  it('keeps compatible legacy output when no format is supplied', () => {
    const diagnostics = [{ severity: 'warning', code: 'sample_warning', message: 'Sample warning' }];

    expect(renderDoctorDiagnostics([], undefined)).toContain('No diagnostics recorded');
    expect(renderDoctorDiagnostics(diagnostics, undefined)).toBe(`${JSON.stringify(diagnostics, null, 2)}\n`);
  });

  it('keeps explicit clean table output human-readable', () => {
    expect(renderDoctorDiagnostics([], 'table')).toContain('No diagnostics recorded');
  });

  it('renders diagnostics as a concise table with capped copyable hints', () => {
    const output = renderDoctorTable([
      {
        severity: 'warning',
        code: 'strict_implementation_candidate_quality',
        message: 'Implementation candidate ambiguity and rejection aggregate',
        total: 4,
        suggestedHints: [
          '--implementation-hint service=/ProductService,operation=/activate,repo=helper-a',
          '--implementation-hint service=/ProductService,operation=/activate,repo=helper-b',
          '--implementation-hint service=/ProductService,operation=/activate,repo=helper-c',
          '--implementation-hint service=/ProductService,operation=/activate,repo=helper-d',
        ],
      },
    ]);

    expect(output).toContain('Severity');
    expect(output).toContain('strict_implementation_candidate_quality');
    expect(output).toContain('total=4');
    expect(output).toContain('try --implementation-hint service=/ProductService,operation=/activate,repo=helper-a');
    expect(output).toContain(
      '... 1 additional hint(s) omitted; use a scoped --implementation-hint',
    );
  });

  it('rejects unsupported doctor formats', () => {
    expect(() => renderDoctorDiagnostics([], 'yaml')).toThrow('Unsupported doctor format: yaml');
  });
});
