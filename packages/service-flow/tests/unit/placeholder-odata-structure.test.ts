import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { substituteVariables } from '../../src/linker/dynamic-edge-resolver.js';
import { analyzeODataPathStructure } from '../../src/linker/odata-path-structure.js';
import {
  classifyODataPathIntent,
  normalizeODataOperationInvocationPath,
} from '../../src/linker/odata-path-normalizer.js';
import { analyzeOperationPath } from '../../src/parsers/operation-path-analysis.js';
import {
  extractPlaceholderKeys,
  scanPlaceholderStructure,
  scanPlaceholders,
} from '../../src/utils/placeholders.js';

function templateExpression(sourceText: string): {
  expression: ts.Expression;
  use: ts.Node;
} {
  const source = ts.createSourceFile(
    'handler.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  );
  let expression: ts.Expression | undefined;
  let use: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'client.send') {
      use = node;
      const argument = node.arguments[0];
      if (argument && ts.isObjectLiteralExpression(argument)) {
        const property = argument.properties.find((item) =>
          ts.isPropertyAssignment(item) && item.name.getText(source) === 'path');
        if (property && ts.isPropertyAssignment(property))
          expression = property.initializer;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!expression || !use) throw new Error('operation_path_fixture_not_found');
  return { expression, use };
}

describe('balanced placeholder scanning of supported expressions', () => {
  it.each([
    ["${choose({ key: 'a/b' })}", "choose({ key: 'a/b' })"],
    ['${`prefix-${tenant.id}`}', '`prefix-${tenant.id}`'],
    ['${value /* } */}', 'value /* } */'],
    ['${value // }\n}', 'value // }\n'],
    ['${/}/.test(value)}', '/}/.test(value)'],
    ['${/[}]/.test(value)}', '/[}]/.test(value)'],
    ['${a / b}', 'a / b'],
  ])('keeps %s as one exact opaque key', (input, key) => {
    const result = scanPlaceholderStructure(input);

    expect(result.status).toBe('balanced');
    expect(result.spans).toEqual([{ start: 0, end: input.length, key }]);
    expect(scanPlaceholders(input)).toEqual(result.spans);
    expect(extractPlaceholderKeys(input)).toEqual([key.trim()]);
    expect(substituteVariables(input, { [key.trim()]: 'resolved' })).toMatchObject({
      effective: 'resolved',
      placeholders: [key.trim()],
      missing: [],
      supplied: [key.trim()],
    });
  });

  it('keeps division after postfix non-null assertions balanced', () => {
    for (const input of ['${foo! / bar}', '${foo?.bar! / baz}']) {
      expect(scanPlaceholderStructure(input)).toMatchObject({
        status: 'balanced',
        spans: [{ start: 0, end: input.length }],
      });
    }
    expect(extractPlaceholderKeys(
      '/${foo! / bar}/rest/${tail}',
    )).toEqual(['foo! / bar', 'tail']);
  });
});

describe('malformed placeholder scanning', () => {
  it('fails closed without publishing a truncated key', () => {
    for (const input of [
      '${choose({ key: 1 })',
      '${value',
      '${value + (other}',
      '${"unterminated}',
    ]) {
      expect(scanPlaceholderStructure(input)).toMatchObject({
        status: 'malformed',
        spans: [],
      });
      expect(scanPlaceholders(input)).toEqual([]);
      expect(extractPlaceholderKeys(input)).toEqual([]);
      expect(substituteVariables(input, { value: 'unsafe' }).effective).toBe(input);
    }
  });
});

describe('placeholder-aware OData delimiter structure', () => {
  it.each([
    ['/Records?$select=ID', true, '/Records', 1, false],
    ["/Records('a?b')", false, "/Records('a?b')", 1, false],
    ["/Records('${id}')", false, "/Records('${id}')", 1, false],
    ["/getRecord(code='${req?.user?.id}')", false,
      "/getRecord(code='${req?.user?.id}')", 1, false],
    ['/${tenantInfo.region?.toLowerCase()}', false,
      '/${tenantInfo.region?.toLowerCase()}', 1, true],
    ['/${prefix}Record', false, '/${prefix}Record', 1, true],
    ['/Records-${tenant}', false, '/Records-${tenant}', 1, true],
    ['/${items[0].service}/details', false,
      '/${items[0].service}/details', 2, true],
    ["/${lookup['a/b']}", false, "/${lookup['a/b']}", 1, true],
    ["/${choose({ key: 'a/b' })}", false,
      "/${choose({ key: 'a/b' })}", 1, true],
    ['/${`prefix-${tenant.id}`}', false,
      '/${`prefix-${tenant.id}`}', 1, true],
    ['/${operationName}?$select=ID', true,
      '/${operationName}', 1, true],
  ])('analyzes %s without crossing opaque spans',
    (path, hasQuery, pathWithoutQuery, segmentCount, runtimeHead) => {
      const result = analyzeODataPathStructure(path);

      expect(result.status).toBe('valid');
      expect(result.queryIndex !== undefined).toBe(hasQuery);
      expect(result.pathWithoutQuery).toBe(pathWithoutQuery);
      expect(result.segments).toHaveLength(segmentCount);
      expect(result.firstSegmentHeadRuntimeDependent).toBe(runtimeHead);
    });

  it('fails closed on malformed query quotes and parentheses', () => {
    expect(analyzeODataPathStructure(
      "/Records?$filter=name eq 'unterminated",
    )).toMatchObject({
      status: 'malformed',
      reason: 'path_quote_is_unbalanced',
    });
    expect(analyzeODataPathStructure(
      '/Records?$filter=(name eq 1',
    )).toMatchObject({
      status: 'malformed',
      reason: 'path_parenthesis_is_unbalanced',
    });
  });

});

describe('placeholder-aware OData intent', () => {
  it.each([
    ['/Records?$select=ID', 'entity_query', []],
    ["/Records('a?b')", 'entity_key_read', []],
    ["/Records('${id}')", 'entity_key_read', ['id']],
    ["/getRecord(code='${req?.user?.id}')",
      'operation_invocation', ['req?.user?.id']],
    ['/${tenantInfo.region?.toLowerCase()}', 'unknown',
      ['tenantInfo.region?.toLowerCase()']],
    ['/${prefix}Record', 'unknown', ['prefix']],
    ['/Records-${tenant}', 'unknown', ['tenant']],
    ['/${items[0].service}/details', 'unknown', ['items[0].service']],
    ["/${lookup['a/b']}", 'unknown', ["lookup['a/b']"]],
    ["/${choose({ key: 'a/b' })}", 'unknown', ["choose({ key: 'a/b' })"]],
    ['/${operationName}?$select=ID', 'unknown', ['operationName']],
  ])('classifies %s as %s', (path, kind, placeholderKeys) => {
    expect(classifyODataPathIntent(path, 'GET')).toMatchObject({
      kind,
      placeholderKeys,
    });
  });

  it('recognizes only the outer operation invocation', () => {
    const path = "/getRecord(code='${encodeURIComponent(value?.id)}')";
    const structure = analyzeODataPathStructure(path);
    const normalized = normalizeODataOperationInvocationPath(path);

    expect(structure).toMatchObject({
      status: 'valid',
      firstSegmentHead: 'getRecord',
      firstSegmentHeadRuntimeDependent: false,
      firstParenthesisPlaceholderKeys: ['encodeURIComponent(value?.id)'],
    });
    expect(normalized).toMatchObject({
      normalizedOperationPath: '/getRecord',
      wasInvocation: true,
      invocationArgumentPlaceholderKeys: ['encodeURIComponent(value?.id)'],
    });
  });

});

describe('placeholder-aware OData malformed and candidate handling', () => {
  it.each([
    ["/Records('a''?b')", 'entity_key_read'],
    ["/Records('a\\'?b')", 'entity_key_read'],
    ['/Records%3Fsegment', 'unknown'],
    ['/Records%2Fsegment', 'unknown'],
    ['/Records%28segment', 'unknown'],
  ])('does not treat encoded or quoted punctuation in %s as delimiters', (path, kind) => {
    const intent = classifyODataPathIntent(path, 'GET');

    expect(intent.kind).toBe(kind);
    expect(intent.hasQueryString).toBe(false);
  });

  it.each([
    '/${value',
    "/Records('unterminated)",
    '/getRecord(code=1',
    '/getRecord(code=1))',
  ])('fails closed for malformed path %s', (path) => {
    expect(() => classifyODataPathIntent(path, 'GET')).not.toThrow();
    expect(classifyODataPathIntent(path, 'GET').kind).toBe('unknown');
  });

  it('keeps operation candidates untruncated around placeholder punctuation', () => {
    const { expression, use } = templateExpression(`
async function run(client: { send(value: unknown): Promise<void> },
  tenantInfo: { region?: string }): Promise<void> {
  await client.send({
    method: 'GET',
    path: \`/\${tenantInfo.region?.toLowerCase()}\`,
  });
}`);
    const analysis = analyzeOperationPath(expression, use, 'GET');

    expect(analysis).toMatchObject({
      status: 'dynamic',
      candidateRawPaths: ['/${tenantInfo.region?.toLowerCase()}'],
      candidateNormalizedOperationPaths: ['/${tenantInfo.region?.toLowerCase()}'],
      placeholderKeys: ['tenantInfo.region?.toLowerCase()'],
    });
  });
});
