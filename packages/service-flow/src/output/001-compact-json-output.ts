import type { CompactGraphV1 } from '../trace/014-compact-contract.js';
import { redactValue } from '../utils/redaction.js';

export function renderCompactJson(value: CompactGraphV1): string {
  return `${JSON.stringify(redactValue(value))}\n`;
}
