import { posix } from 'node:path';
import ts from 'typescript';
import { normalizePath } from '../utils/path-utils.js';
import { resolveBinding } from './query-entity-resolution.js';
import {
  collectSymbolImportBindings,
  lexicalIdentifierDeclaration,
  type SymbolImportBinding,
} from './symbol-import-bindings.js';
import type { RepositorySourceContext } from './ts-project.js';
import { EVENT_ENVIRONMENT_KEY_ALLOWLIST } from
  './environment-declarations.js';

export type EventEnvironmentTransform = 'toUpperCase' | 'toLowerCase';

export interface EventEnvironmentReference {
  status: 'resolved' | 'refused';
  sourceKey: string;
  environmentKey?: string;
  transforms: EventEnvironmentTransform[];
  sourceFile?: string;
  startOffset?: number;
  endOffset?: number;
  reason?: string;
}

export type EventEnvironmentReferenceResolver = (
  expression: ts.Expression,
) => EventEnvironmentReference | undefined;

interface ResolutionContext {
  sources: RepositorySourceContext;
  source: ts.SourceFile;
  sourceFile: string;
  depth: number;
  seen: Set<string>;
}

const maxEnvironmentReferenceDepth = 6;
const allowedEnvironmentKeys = new Set<string>(
  EVENT_ENVIRONMENT_KEY_ALLOWLIST,
);

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression))
    return unwrapExpression(expression.expression);
  return expression;
}

function processEnvironmentKey(
  expression: ts.Expression,
): string | undefined {
  if (!ts.isPropertyAccessExpression(expression)
    || !ts.isPropertyAccessExpression(expression.expression)
    || !ts.isIdentifier(expression.expression.expression)
    || expression.expression.expression.text !== 'process'
    || expression.expression.name.text !== 'env'
    || lexicalIdentifierDeclaration(expression.expression.expression))
    return undefined;
  return expression.name.text;
}

function relativeCandidates(
  callerFile: string,
  specifier: string,
): string[] {
  const base = normalizePath(posix.normalize(
    posix.join(posix.dirname(callerFile), specifier),
  ));
  return /\.[jt]s$/.test(base)
    ? [base]
    : [`${base}.ts`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`];
}

function bindingFor(
  identifier: ts.Identifier,
  bindings: readonly SymbolImportBinding[],
): SymbolImportBinding | undefined {
  const declaration = lexicalIdentifierDeclaration(identifier);
  if (!declaration) return undefined;
  const start = declaration.getStart(identifier.getSourceFile());
  const end = declaration.getEnd();
  const matches = bindings.filter((binding) =>
    binding.localName === identifier.text
    && binding.bindingSiteStartOffset === start
    && binding.bindingSiteEndOffset === end);
  return matches.length === 1 ? matches[0] : undefined;
}

function exportedVariableInitializer(
  source: ts.SourceFile,
  name: string,
): ts.Expression | undefined {
  const exportNames = new Set(source.statements.flatMap((statement) =>
    ts.isExportDeclaration(statement) && !statement.moduleSpecifier
      && statement.exportClause && ts.isNamedExports(statement.exportClause)
      ? statement.exportClause.elements.map((element) =>
          element.propertyName?.text ?? element.name.text)
      : []));
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = ts.canHaveModifiers(statement)
      && ts.getModifiers(statement)?.some((modifier) =>
        modifier.kind === ts.SyntaxKind.ExportKeyword);
    for (const declaration of statement.declarationList.declarations)
      if (ts.isIdentifier(declaration.name)
        && declaration.name.text === name
        && (exported || exportNames.has(name))
        && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0)
        return declaration.initializer;
  }
  return undefined;
}

function importedIdentifier(
  identifier: ts.Identifier,
  context: ResolutionContext,
): { source: ts.SourceFile; sourceFile: string;
  initializer: ts.Expression } | undefined {
  const binding = bindingFor(
    identifier, collectSymbolImportBindings(context.source),
  );
  if (!binding || binding.typeOnly || binding.moduleKind !== 'relative'
    || !binding.importedName) return undefined;
  const candidates = relativeCandidates(
    context.sourceFile, binding.rawModuleSpecifier,
  ).flatMap((filePath) => {
    const snapshot = context.sources.get(filePath);
    return snapshot ? [{ sourceFile: filePath, source: snapshot.sourceFile() }]
      : [];
  });
  if (candidates.length !== 1 || !candidates[0]) return undefined;
  const initializer = exportedVariableInitializer(
    candidates[0].source, binding.importedName,
  );
  return initializer ? { ...candidates[0], initializer } : undefined;
}

function transformedReference(
  expression: ts.CallExpression,
  context: ResolutionContext,
): EventEnvironmentReference | undefined {
  if (!ts.isPropertyAccessExpression(expression.expression)) return undefined;
  const method = expression.expression.name.text;
  const base = resolveEnvironmentReference(
    expression.expression.expression, context,
  );
  if (!base) return undefined;
  if (expression.arguments.length !== 0
    || !['toUpperCase', 'toLowerCase'].includes(method)) return {
    ...base,
    status: 'refused',
    reason: 'event_environment_transform_unsupported',
  };
  return base.status === 'resolved'
    ? {
        ...base,
        transforms: [
          ...base.transforms, method as EventEnvironmentTransform,
        ],
      }
    : base;
}

function identifierReference(
  identifier: ts.Identifier,
  context: ResolutionContext,
): EventEnvironmentReference | undefined {
  const local = resolveBinding(identifier, identifier);
  if (local.declaration && local.initializer && local.immutable)
    return resolveEnvironmentReference(local.initializer, context);
  const imported = importedIdentifier(identifier, context);
  if (!imported) return undefined;
  return resolveEnvironmentReference(imported.initializer, {
    ...context,
    source: imported.source,
    sourceFile: imported.sourceFile,
    depth: context.depth + 1,
  });
}

function resolveEnvironmentReference(
  expression: ts.Expression,
  context: ResolutionContext,
): EventEnvironmentReference | undefined {
  const sourceKey = expression.getText(context.source);
  if (context.depth >= maxEnvironmentReferenceDepth
    || context.seen.has(`${context.sourceFile}\0${sourceKey}`)) return {
    status: 'refused', sourceKey, transforms: [],
    reason: 'event_environment_reference_ambiguous',
  };
  const seen = new Set(context.seen).add(
    `${context.sourceFile}\0${sourceKey}`,
  );
  const next = { ...context, depth: context.depth + 1, seen };
  const value = unwrapExpression(expression);
  const key = processEnvironmentKey(value);
  if (key && allowedEnvironmentKeys.has(key)) return {
    status: 'resolved', sourceKey, environmentKey: key, transforms: [],
    sourceFile: context.sourceFile,
    startOffset: value.getStart(context.source), endOffset: value.getEnd(),
  };
  if (key) return undefined;
  if (ts.isCallExpression(value))
    return transformedReference(value, next);
  return ts.isIdentifier(value)
    ? identifierReference(value, next) : undefined;
}

export function createEventEnvironmentReferenceResolver(
  sources: RepositorySourceContext,
  source: ts.SourceFile,
  sourceFile: string,
): EventEnvironmentReferenceResolver {
  return (expression) => resolveEnvironmentReference(expression, {
    sources, source, sourceFile, depth: 0, seen: new Set(),
  });
}

export function applyEventEnvironmentTransforms(
  value: string,
  transforms: readonly EventEnvironmentTransform[],
): string {
  return transforms.reduce((current, transform) =>
    transform === 'toUpperCase'
      ? current.toUpperCase() : current.toLowerCase(), value);
}
