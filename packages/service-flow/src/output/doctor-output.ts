import pc from 'picocolors';
import { renderJson } from './json-output.js';

type Diagnostic = Record<string, unknown>;

export function renderDoctorDiagnostics(diagnostics: Diagnostic[], format: string | undefined): string {
  if (format === 'json') return renderJson(diagnostics);
  if (format === 'table') return renderDoctorTable(diagnostics);
  if (format) throw new Error(`Unsupported doctor format: ${format}. Expected json or table.`);
  return renderLegacyDoctorOutput(diagnostics);
}

function renderLegacyDoctorOutput(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return cleanDoctorMessage();
  return renderJson(diagnostics);
}

export function renderDoctorTable(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return cleanDoctorMessage();
  const rows = diagnostics.map((diagnostic) => ({
    severity: String(diagnostic.severity ?? 'info'),
    code: String(diagnostic.code ?? 'diagnostic'),
    location: diagnosticLocation(diagnostic),
    message: compactMessage(diagnostic),
    hints: suggestedHintLines(diagnostic),
  }));
  const widths = {
    severity: columnWidth('Severity', rows.map((row) => row.severity), 10),
    code: columnWidth('Code', rows.map((row) => row.code), 44),
    location: columnWidth('Location', rows.map((row) => row.location), 28),
  };
  const lines = [
    `${'Severity'.padEnd(widths.severity)} ${'Code'.padEnd(widths.code)} ${'Location'.padEnd(widths.location)} Message`,
    `${'-'.repeat(widths.severity)} ${'-'.repeat(widths.code)} ${'-'.repeat(widths.location)} ${'-'.repeat(7)}`,
  ];
  for (const row of rows) {
    lines.push(`${truncate(row.severity, widths.severity).padEnd(widths.severity)} ${truncate(row.code, widths.code).padEnd(widths.code)} ${truncate(row.location, widths.location).padEnd(widths.location)} ${row.message}`);
    lines.push(...row.hints.map((hint) => `  try ${hint}`));
  }
  return `${lines.join('\n')}\n`;
}

function diagnosticLocation(diagnostic: Diagnostic): string {
  const file = diagnostic.sourceFile ?? diagnostic.file;
  const line = diagnostic.sourceLine ?? diagnostic.line;
  if (file || line) return `${String(file ?? '')}:${String(line ?? '')}`;
  return '-';
}

function compactMessage(diagnostic: Diagnostic): string {
  const message = String(diagnostic.message ?? '');
  const count = typeof diagnostic.count === 'number' ? ` count=${diagnostic.count}` : '';
  const total = typeof diagnostic.total === 'number' ? ` total=${diagnostic.total}` : '';
  return `${message}${count}${total}`.trim();
}

function suggestedHintLines(diagnostic: Diagnostic): string[] {
  const direct = cliHints(diagnostic.suggestedHints);
  if (direct.length > 0) return cappedHints(direct);
  return cappedHints(cliHintsFromSuggestions(diagnostic.implementationHintSuggestions));
}

function cliHints(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function cliHintsFromSuggestions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    return typeof item.cli === 'string' ? [item.cli] : [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cappedHints(hints: string[]): string[] {
  const unique = [...new Set(hints)];
  const shown = unique.slice(0, 3);
  if (unique.length > shown.length) shown.push(`... ${unique.length - shown.length} more hint(s) available in --format json`);
  return shown;
}

function cleanDoctorMessage(): string {
  return `${pc.green('No diagnostics recorded')}\n`;
}

function columnWidth(header: string, values: string[], max: number): number {
  return Math.min(max, Math.max(header.length, ...values.map((value) => value.length)));
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}
