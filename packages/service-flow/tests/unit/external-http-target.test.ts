import { describe, expect, it } from 'vitest';
import { externalHttpTarget } from '../../src/linker/external-http-target.js';

describe('external HTTP target normalization', () => {
  it('builds stable semantic labels without numeric call ids or secrets', () => {
    const target = externalHttpTarget({ id: 42, method: 'GET', evidence_json: JSON.stringify({ externalTarget: { kind: 'static_url', expression: 'https://user:pass@example.test/records?token=secret&id=1' } }) });
    expect(target.toKind).toBe('external_endpoint');
    expect(target.toId).not.toBe('42');
    expect(target.label).toContain('External endpoint: GET https://example.test/records');
    expect(target.label).toContain('token=%3Credacted%3E');
    expect(target.label).not.toContain('secret');
    expect(target.label).not.toContain('user:pass');
  });

  it('builds destination and dynamic endpoint targets', () => {
    expect(externalHttpTarget({ evidence_json: JSON.stringify({ externalTarget: { kind: 'destination', expression: 'ANALYTICS_API' } }) }).label).toBe('External destination: ANALYTICS_API');
    const dynamic = externalHttpTarget({ evidence_json: JSON.stringify({ externalTarget: { kind: 'url_expression', expression: 'baseUrl + path' } }) });
    expect(dynamic.dynamic).toBe(true);
    expect(dynamic.label).toBe('External endpoint: dynamic URL');
  });
});
