import { describe, expect, it } from 'vitest';
import { normalizeDecoratorOperation, normalizeDecoratorOperationSignal } from '../../src/linker/operation-decorator-normalizer.js';

describe('operation decorator normalization', () => {
  it('normalizes only resolved values and never guesses from identifier text', () => {
    expect(normalizeDecoratorOperation('publishRecord', undefined)).toBe('publishRecord');
    expect(normalizeDecoratorOperation('ActionPublishRecord', undefined))
      .toBe('ActionPublishRecord');
    expect(normalizeDecoratorOperation('FuncLookupRecord', undefined))
      .toBe('FuncLookupRecord');
    expect(normalizeDecoratorOperation(
      undefined,
      'api.service.CatalogService.ActionPublishRecord.name',
    )).toBeUndefined();
    expect(normalizeDecoratorOperation('ActionableThing', undefined)).toBe('ActionableThing');
  });

  it('distinguishes unsupported expressions from contradictory targets', () => {
    expect(normalizeDecoratorOperationSignal(undefined, 'String(readRecord)', 'readRecord')).toEqual({ status: 'resolved', operationName: 'readRecord', raw: 'String(readRecord)' });
    expect(normalizeDecoratorOperationSignal(undefined, 'String(otherRecord)', 'readRecord')).toMatchObject({ status: 'unsupported', reason: 'string_wrapper_identifier_not_resolved' });
    expect(normalizeDecoratorOperationSignal(undefined, 'String(readRecord())', 'readRecord')).toMatchObject({ status: 'unsupported' });
    expect(normalizeDecoratorOperationSignal(undefined, 'decorators[operationName]', 'readRecord')).toMatchObject({ status: 'unsupported' });
    expect(normalizeDecoratorOperationSignal('archiveRecord', undefined, 'readRecord')).toEqual({ status: 'resolved', operationName: 'archiveRecord', raw: undefined });
  });
});
