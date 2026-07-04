import { describe, expect, it } from 'vitest';
import { normalizeODataOperationInvocationPath } from '../../src/linker/odata-path-normalizer.js';

describe('normalizeODataOperationInvocationPath', () => {
  it.each([
    ['/readConfig', '/readConfig', false],
    ['/readConfig()', '/readConfig', true],
    ["/readConfig(id='123')", '/readConfig', true],
    ["/readConfig(id='${encodeURIComponent(value)}',version=0)", '/readConfig', true],
    ["/readConfig(id='${helper(format(value))}',version=0)", '/readConfig', true],
    ["/readConfig(\n  id='123',\n  version=0\n)", '/readConfig', true],
    ["/Namespace.readConfig(id='123')", '/Namespace.readConfig', true],
    ["/Documents(id='123')/file", "/Documents(id='123')/file", false],
    ["/Orders(id='123')/items", "/Orders(id='123')/items", false],
  ])('normalizes %s', (input, expected, wasInvocation) => {
    expect(normalizeODataOperationInvocationPath(input)).toMatchObject({ normalizedOperationPath: expected, wasInvocation });
  });

  it('leaves empty paths unresolved for existing missing path handling', () => {
    expect(normalizeODataOperationInvocationPath(undefined)).toBeUndefined();
    expect(normalizeODataOperationInvocationPath('   ')).toBeUndefined();
  });
});
