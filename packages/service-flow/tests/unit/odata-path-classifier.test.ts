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
it.each([
  ['/Documents', 'GET', 'entity_candidate', 'Documents'],
  ['/Documents', 'POST', 'entity_mutation', 'Documents'],
  ["/Documents('${id}')", 'PATCH', 'entity_mutation', 'Documents'],
  ['/Documents(${document.ID})/content', 'PUT', 'entity_media', 'Documents'],
  ["/Documents('${id}')", 'DELETE', 'entity_delete', 'Documents'],
  ["/Documents('${id}')/items", 'GET', 'entity_media', 'Documents'],
  ['/submitOrder', 'POST', 'operation_invocation', 'submitOrder'],
  ['/calculatePrice', 'GET', 'unknown', 'calculatePrice'],
  ['/UnknownThings', 'POST', 'entity_mutation', 'UnknownThings'],
  ['/unknownThing', 'POST', 'operation_invocation', 'unknownThing'],
])('classifies service-client path %s %s conservatively', (path, method, kind, entitySegment) => {
  expect(classifyODataPathIntent(path, method)).toMatchObject({ kind, entitySegment });
});

});

describe('entity-key placeholders versus operation arguments', () => {
  it.each([
    ['/DocumentAttachment(${attachment.ID})/file', 'PUT', 'entity_media', ['attachment.ID'], 'file'],
    ["/DocumentAttachment('${file.ID}')/content", 'PUT', 'entity_media', ['file.ID'], 'content'],
    ['/DocumentAttachment(${attachmentID})', 'GET', 'entity_key_read', ['attachmentID'], undefined],
    ['/refreshCache(id=${request.ID})', 'POST', 'operation_invocation', [], undefined],
  ])('separates placeholder evidence for %s', (path, method, kind, keyPlaceholders, suffix) => {
    expect(classifyODataPathIntent(path, method)).toMatchObject({
      kind,
      keyPredicatePlaceholderKeys: keyPlaceholders,
      mediaOrPropertySuffix: suffix,
    });
  });
});
