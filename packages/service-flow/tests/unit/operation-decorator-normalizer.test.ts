import { describe, expect, it } from 'vitest';
import { normalizeDecoratorOperation } from '../../src/linker/operation-decorator-normalizer.js';

describe('operation decorator normalization', () => {
  it('normalizes literal and generated action/function decorator names conservatively', () => {
    expect(normalizeDecoratorOperation('publishRecord', undefined)).toBe('publishRecord');
    expect(normalizeDecoratorOperation('ActionPublishRecord', undefined)).toBe('publishRecord');
    expect(normalizeDecoratorOperation('FuncLookupRecord', undefined)).toBe('lookupRecord');
    expect(normalizeDecoratorOperation(undefined, 'api.service.CatalogService.ActionPublishRecord.name')).toBe('publishRecord');
    expect(normalizeDecoratorOperation('ActionableThing', undefined)).toBe('ActionableThing');
  });
});
