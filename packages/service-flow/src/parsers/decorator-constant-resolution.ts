import { posix } from 'node:path';
import ts from 'typescript';
import { normalizePath } from '../utils/path-utils.js';
import {
  collectStringConstantLookups,
  type StaticStringConstant,
  type StaticStringLookupResult,
} from './string-constant-lookups.js';
import {
  collectSymbolImportBindings,
  lexicalIdentifierDeclaration,
  type SymbolImportBinding,
} from './symbol-import-bindings.js';
import type { RepositorySourceContext } from './ts-project.js';

type DecoratorConstantLookupResult =
  | {
      status: 'resolved';
      constant: StaticStringConstant;
      resolutionKind: StaticStringConstant['kind']
        | 'generated_constant_name';
    }
  | Exclude<StaticStringLookupResult, { status: 'resolved' }>;

export type DecoratorConstantResolver = (
  expression: ts.Expression,
) => DecoratorConstantLookupResult;

type ConstantImportBinding = Pick<
  SymbolImportBinding,
  'bindingKind' | 'importedName' | 'rawModuleSpecifier' | 'typeOnly'
>;

function expressionSegments(
  expression: ts.Expression,
): string[] | undefined {
  if (ts.isIdentifier(expression)) return [expression.text];
  if (!ts.isPropertyAccessExpression(expression)
    || expression.questionDotToken) return undefined;
  const base = expressionSegments(expression.expression);
  return base ? [...base, expression.name.text] : undefined;
}

function bindingFor(
  identifier: ts.Identifier,
  bindings: readonly SymbolImportBinding[],
): ConstantImportBinding | undefined {
  const declaration = lexicalIdentifierDeclaration(identifier);
  if (!declaration) return undefined;
  const start = declaration.getStart(identifier.getSourceFile());
  const end = declaration.getEnd();
  const matches = bindings.filter((binding) =>
    binding.localName === identifier.text
    && binding.bindingSiteStartOffset === start
    && binding.bindingSiteEndOffset === end);
  if (matches.length === 1) return matches[0];
  return modelImportBinding(declaration);
}

function modelImportBinding(
  declaration: ts.Identifier,
): ConstantImportBinding | undefined {
  let current: ts.Node | undefined = declaration.parent;
  while (current && !ts.isImportDeclaration(current))
    current = current.parent;
  if (!current || !ts.isStringLiteralLike(current.moduleSpecifier)
    || !current.moduleSpecifier.text.startsWith('#cds-models'))
    return undefined;
  const clause = current.importClause;
  if (!clause) return undefined;
  if (clause.name === declaration) return {
    bindingKind: 'esm_default',
    importedName: 'default',
    rawModuleSpecifier: current.moduleSpecifier.text,
    typeOnly: clause.isTypeOnly,
  };
  const named = clause.namedBindings;
  if (named && ts.isNamespaceImport(named) && named.name === declaration)
    return {
      bindingKind: 'esm_namespace',
      importedName: null,
      rawModuleSpecifier: current.moduleSpecifier.text,
      typeOnly: clause.isTypeOnly,
    };
  const specifier = named && ts.isNamedImports(named)
    ? named.elements.find((element) => element.name === declaration)
    : undefined;
  return specifier ? {
    bindingKind: 'esm_named',
    importedName: specifier.propertyName?.text ?? specifier.name.text,
    rawModuleSpecifier: current.moduleSpecifier.text,
    typeOnly: clause.isTypeOnly || specifier.isTypeOnly,
  } : undefined;
}

function relativeCandidates(
  callerFile: string,
  specifier: string,
): string[] {
  const requested = normalizePath(posix.normalize(
    posix.join(posix.dirname(callerFile), specifier),
  ));
  const base = requested.replace(/\.(?:m|c)?[jt]s$/, '');
  return [
    requested,
    `${base}.ts`,
    `${base}.js`,
    `${base}/index.ts`,
    `${base}/index.js`,
  ];
}

function modelCandidate(
  filePath: string,
  specifier: string,
): boolean {
  const suffix = specifier.replace(/^#cds-models\/?/, '');
  const module = normalizePath(filePath)
    .replace(/\.(?:d\.)?(?:ts|js)$/, '');
  const expected = `@cds-models/${suffix}`;
  return module === expected
    || module === `${expected}/index`
    || module.endsWith(`/${expected}`)
    || module.endsWith(`/${expected}/index`);
}

function targetFiles(
  context: RepositorySourceContext,
  callerFile: string,
  binding: ConstantImportBinding,
): string[] {
  if (binding.rawModuleSpecifier.startsWith('.'))
    return relativeCandidates(callerFile, binding.rawModuleSpecifier)
      .filter((candidate) => context.get(candidate));
  if (binding.rawModuleSpecifier.startsWith('#cds-models'))
    return context.entries().map((snapshot) => snapshot.filePath)
      .filter((filePath) =>
        modelCandidate(filePath, binding.rawModuleSpecifier));
  return [];
}

function targetKey(
  binding: ConstantImportBinding,
  segments: readonly string[],
): string | undefined {
  const tail = segments.slice(1);
  if (binding.bindingKind === 'esm_namespace'
    || binding.bindingKind === 'cjs_namespace')
    return tail.length > 0 ? tail.join('.') : undefined;
  if (!binding.importedName || binding.importedName === 'default')
    return undefined;
  return [binding.importedName, ...tail].join('.');
}

function resolveTarget(
  context: RepositorySourceContext,
  filePath: string,
  key: string,
  generatedModel: boolean,
): DecoratorConstantLookupResult {
  const snapshot = context.get(filePath);
  if (!snapshot) return { status: 'not_found' };
  const lookups = collectStringConstantLookups(snapshot.sourceFile());
  const constant = lookups.identifiers.get(key)
    ?? lookups.enumMembers.get(key)
    ?? lookups.objectProperties.get(key);
  if (constant?.exported && constant.stable)
    return {
      status: 'resolved',
      constant,
      resolutionKind: generatedModel
        ? 'generated_constant_name' : constant.kind,
    };
  const refusal = lookups.refusedMembers.get(key);
  return {
    status: 'refused',
    reason: refusal?.reason ?? (constant
      ? 'decorator_constant_not_exported'
      : 'decorator_constant_not_resolved'),
  };
}

export function createDecoratorConstantResolver(
  context: RepositorySourceContext,
  source: ts.SourceFile,
  sourceFile: string,
): DecoratorConstantResolver {
  const bindings = collectSymbolImportBindings(source);
  return (expression) => {
    const segments = expressionSegments(expression);
    const root = rootIdentifier(expression);
    if (!segments || !root) return { status: 'not_found' };
    const binding = bindingFor(root, bindings);
    if (binding?.typeOnly) return {
      status: 'refused',
      reason: 'decorator_constant_type_only',
    };
    const key = binding ? targetKey(binding, segments) : undefined;
    if (!binding || !key) return { status: 'not_found' };
    const files = targetFiles(context, sourceFile, binding);
    return files.length === 1 && files[0]
      ? resolveTarget(
          context, files[0], key,
          binding.rawModuleSpecifier.startsWith('#cds-models'),
        )
      : {
          status: 'refused',
          reason: 'decorator_constant_target_ambiguous',
        };
  };
}

function rootIdentifier(
  expression: ts.Expression,
): ts.Identifier | undefined {
  let current = expression;
  while (ts.isPropertyAccessExpression(current))
    current = current.expression;
  return ts.isIdentifier(current) ? current : undefined;
}
