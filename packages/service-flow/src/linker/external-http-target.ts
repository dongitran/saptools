import { createHash } from 'node:crypto';

export type ExternalTargetKind = 'destination' | 'static_url' | 'url_expression' | 'unknown';
export interface ExternalHttpTarget { kind: ExternalTargetKind; toKind: 'external_destination' | 'external_endpoint'; toId: string; label: string; method?: string; dynamic: boolean; expression?: string; }
const sensitiveKeys = new Set(['token','access_token','id_token','api_key','apikey','key','password','passwd','pwd','secret','client_secret','authorization','cookie','signature']);
function hash(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 12); }
function methodPrefix(method: unknown): string { return typeof method === 'string' && method.length > 0 ? `${method.toUpperCase()} ` : ''; }
export function redactUrl(value: string): string {
  try {
    const url = new URL(value, value.startsWith('/') ? 'https://relative.invalid' : undefined);
    url.username = ''; url.password = '';
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, sensitiveKeys.has(key.toLowerCase()) ? '<redacted>' : '<redacted>');
    const path = `${url.pathname}${url.search ? url.search : ''}`;
    return value.startsWith('/') ? path : `${url.origin}${path}`;
  } catch {
    return value.replace(/([?&][^=;&]*(?:token|key|password|secret|cookie|authorization)[^=;&]*=)[^&]*/gi, '$1<redacted>');
  }
}
export function externalHttpTarget(call: Record<string, unknown>): ExternalHttpTarget {
  const evidence = typeof call.evidence_json === 'string' ? safeParse(call.evidence_json) : {};
  const target = evidence.externalTarget && typeof evidence.externalTarget === 'object' && !Array.isArray(evidence.externalTarget) ? evidence.externalTarget as Record<string, unknown> : {};
  const method = typeof call.method === 'string' ? call.method : typeof target.method === 'string' ? target.method : undefined;
  const kind = typeof target.kind === 'string' ? target.kind : 'unknown';
  const expression = typeof target.expression === 'string' ? target.expression : undefined;
  if (kind === 'destination' && target.dynamic === true) {
    const shape = typeof target.expressionShape === 'string' ? target.expressionShape : 'expression';
    const candidates = Array.isArray(target.candidateLiterals) ? target.candidateLiterals.filter((item): item is string => typeof item === 'string') : [];
    return { kind, toKind: 'external_destination', toId: `destination:dynamic:${hash(`${shape}:${candidates.join('|')}`)}`, label: 'External destination: dynamic destination', method, dynamic: true, expression: candidates.length ? `candidates:${candidates.join('|')}` : `shape:${shape}` };
  }
  if (kind === 'destination' && expression) return { kind, toKind: 'external_destination', toId: `destination:${expression}`, label: `External destination: ${expression}`, method, dynamic: false, expression };
  if (kind === 'static_url' && expression) {
    const redacted = redactUrl(expression);
    return { kind, toKind: 'external_endpoint', toId: `endpoint:${hash(`${method ?? ''}:${redacted}`)}`, label: `External endpoint: ${methodPrefix(method)}${redacted}`, method, dynamic: false, expression: redacted };
  }
  if (kind === 'url_expression' && expression) return { kind, toKind: 'external_endpoint', toId: `dynamic:${hash(expression)}`, label: `External endpoint: ${methodPrefix(method)}dynamic URL`, method, dynamic: true, expression: `expr:${hash(expression)}` };
  return { kind: 'unknown', toKind: 'external_endpoint', toId: 'unknown', label: 'External endpoint: unknown', method, dynamic: false };
}
function safeParse(value: string): Record<string, unknown> { try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
