export interface DiagnosticInput {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  sourceFile?: string;
  sourceLine?: number;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
