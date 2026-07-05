import { describe, expect, it } from 'vitest';
import { normalizeODataOperationInvocationPath } from '../../src/linker/odata-path-normalizer.js';

describe('normalizeODataOperationInvocationPath', () => {
  it.each([
    ['/readDetails', '/readDetails', false],
    ['/readDetails()', '/readDetails', true],
    ["/readDetails(ID='1000',version=0)", '/readDetails', true],
    ["/readDetails(ID='${id}',version=0)", '/readDetails', true],
    ["/readDetails(ID='${encodeURIComponent(\n  id\n)}',version=0)", '/readDetails', true],
    ["/readDetails(ID='${encodeURIComponent(id)}',version=${\n  version ? version : 0\n})", '/readDetails', true],
    ["/readDetails(ID=${formatValue(helper(\n  id\n))},version=0)", '/readDetails', true],
    ["/readDetails(\n  ID='1000',\n  version=0\n)", '/readDetails', true],
    ["/Namespace.readDetails(ID='1000')", '/Namespace.readDetails', true],
    ["/Books(ID='1000')/author", "/Books(ID='1000')/author", false],
    ["/Books?$filter=contains(title,'A')", "/Books?$filter=contains(title,'A')", false],
    ["/readDetails(ID='1000')?$select=value", "/readDetails(ID='1000')?$select=value", false],
  ])('normalizes %s', (input, expected, wasInvocation) => {
    expect(normalizeODataOperationInvocationPath(input)).toMatchObject({ normalizedOperationPath: expected, wasInvocation });
  });

  it('reports invocation argument placeholders as non-routing evidence', () => {
    expect(normalizeODataOperationInvocationPath("/readDetails(ID='${encodeURIComponent(\n  id\n)}',version=${\n  version ? version : 0\n})")).toMatchObject({
      normalizedOperationPath: '/readDetails',
      wasInvocation: true,
      invocationArgumentPlaceholderKeys: ['encodeURIComponent(\n  id\n)', 'version ? version : 0'],
      normalizationReason: 'balanced_top_level_operation_invocation',
    });
  });

  it('leaves empty paths unresolved for existing missing path handling', () => {
    expect(normalizeODataOperationInvocationPath(undefined)).toBeUndefined();
    expect(normalizeODataOperationInvocationPath('   ')).toBeUndefined();
  });
});
