import { describe, expect, it } from 'vitest';
import { classifyODataPathIntent } from '../../src/linker/odata-path-normalizer.js';

describe('classifyODataPathIntent', () => {
  it.each([
    ["/Books?$filter=contains(title,'A')", 'GET', 'entity_query', 'Books'],
    ["/Books?$skiptoken=${token}", 'GET', 'entity_query', 'Books'],
    ["/Books(ID='1000')", 'GET', 'entity_key_read', 'Books'],
    ["/Authors('A1')/books?$select=ID", 'GET', 'entity_navigation_query', 'Authors'],
    ["/calculateScore(input='A')", 'GET', 'operation_invocation', 'calculateScore'],
    ["/calculateScore(input='A')?$select=value", 'GET', 'unknown', 'calculateScore'],
  ])('classifies %s as %s', (path, method, kind, entitySegment) => {
    expect(classifyODataPathIntent(path, method)).toMatchObject({ kind, entitySegment });
  });

  it('records query placeholders without making the service path dynamic', () => {
    expect(classifyODataPathIntent('/Books?$skiptoken=${token}', 'GET')).toMatchObject({
      kind: 'entity_query',
      hasQueryString: true,
      placeholderKeys: ['token'],
      reason: 'get_collection_path_has_query_string',
    });
  });
});
