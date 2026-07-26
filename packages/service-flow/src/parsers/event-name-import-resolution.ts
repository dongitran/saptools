import { posix } from 'node:path';
import ts from 'typescript';
import { normalizePath } from '../utils/path-utils.js';
import {
  collectStringConstantLookups,
  type StaticStringConstant,
  type StaticStringLookupResult,
  type StringConstantLookups,
} from './string-constant-lookups.js';
import {
  collectSymbolImportBindings,
  derivedMemberImportReference,
  lexicalIdentifierDeclaration,
  type SymbolImportBinding,
  type SymbolImportReference,
} from './symbol-import-bindings.js';
import type { RepositorySourceContext } from './ts-project.js';

interface ImportedMemberRequest {
  binding: SymbolImportBinding;
  containerName: string;
  memberName?: string;
}

export type ImportedEventNameResult =
  | { status: 'resolved'; constant: StaticStringConstant }
  | { status: 'not_found' }
  | {
      status: 'refused';
      reason: string;
      packageImportReference?: SymbolImportReference;
    };
export type ImportedEventNameResolver = (
  expression: ts.Expression,
) => ImportedEventNameResult;

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

function directMemberRequest(
  expression: ts.PropertyAccessExpression,
  bindings: readonly SymbolImportBinding[],
): ImportedMemberRequest | undefined {
  if (!ts.isIdentifier(expression.expression)) return undefined;
  const binding = bindingFor(expression.expression, bindings);
  if (!binding || binding.typeOnly || binding.importedName === null)
    return undefined;
  return {
    binding,
    containerName: binding.importedName,
    memberName: expression.name.text,
  };
}

function namespaceMemberRequest(
  expression: ts.PropertyAccessExpression,
  bindings: readonly SymbolImportBinding[],
): ImportedMemberRequest | undefined {
  const container = expression.expression;
  if (!ts.isPropertyAccessExpression(container)
    || !ts.isIdentifier(container.expression)) return undefined;
  const binding = bindingFor(container.expression, bindings);
  if (!binding || binding.typeOnly
    || !['esm_namespace', 'cjs_namespace'].includes(binding.bindingKind))
    return undefined;
  return {
    binding,
    containerName: container.name.text,
    memberName: expression.name.text,
  };
}

function importedMemberRequest(
  expression: ts.Expression,
  bindings: readonly SymbolImportBinding[],
): ImportedMemberRequest | undefined {
  if (ts.isIdentifier(expression)) {
    const binding = bindingFor(expression, bindings);
    return binding && !binding.typeOnly && binding.importedName
      ? { binding, containerName: binding.importedName }
      : undefined;
  }
  if (!ts.isPropertyAccessExpression(expression)
    || expression.questionDotToken) return undefined;
  return directMemberRequest(expression, bindings)
    ?? namespaceMemberRequest(expression, bindings);
}

function rootIdentifier(
  expression: ts.Expression,
): ts.Identifier | undefined {
  if (ts.isIdentifier(expression)) return expression;
  if (ts.isPropertyAccessExpression(expression)
    || ts.isElementAccessExpression(expression))
    return rootIdentifier(expression.expression);
  return undefined;
}

function importedAliasBinding(
  identifier: ts.Identifier,
  bindings: readonly SymbolImportBinding[],
): SymbolImportBinding | undefined {
  const direct = bindingFor(identifier, bindings);
  if (direct) return direct;
  const declaration = lexicalIdentifierDeclaration(identifier);
  if (!declaration || !ts.isVariableDeclaration(declaration.parent))
    return undefined;
  const initializer = declaration.parent.initializer;
  return initializer && ts.isIdentifier(initializer)
    ? bindingFor(initializer, bindings) : undefined;
}

function unsupportedImportedContainer(
  expression: ts.Expression,
  bindings: readonly SymbolImportBinding[],
): boolean {
  const root = rootIdentifier(expression);
  return Boolean(root && importedAliasBinding(root, bindings));
}

function constantImportReference(
  request: ImportedMemberRequest,
): SymbolImportReference | undefined {
  const binding = request.binding;
  if (!request.memberName) {
    if (!binding.importedName) return undefined;
    return {
      ...binding,
      referenceShape: 'identifier',
      referencedMemberName: null,
      requestedPublicName: binding.importedName,
    };
  }
  if (binding.bindingKind !== 'esm_namespace'
    && binding.bindingKind !== 'cjs_namespace')
    return derivedMemberImportReference(binding, request.memberName);
  const requestedPublicName =
    `${request.containerName}.${request.memberName}`;
  return {
    ...binding,
    referenceShape: 'namespace_member',
    referencedMemberName: requestedPublicName,
    requestedPublicName,
  };
}

function relativeCandidates(
  callerFile: string,
  specifier: string,
): string[] {
  const base = normalizePath(posix.normalize(
    posix.join(posix.dirname(callerFile), specifier),
  ));
  if (/\.[jt]s$/.test(base)) return [base];
  return [
    `${base}.ts`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`,
  ];
}

function targetLookups(
  context: RepositorySourceContext,
  callerFile: string,
  request: ImportedMemberRequest,
): StringConstantLookups[] {
  if (request.binding.moduleKind !== 'relative') return [];
  return relativeCandidates(
    callerFile, request.binding.rawModuleSpecifier,
  ).flatMap((candidate) => {
    const snapshot = context.get(candidate);
    return snapshot
      ? [collectStringConstantLookups(snapshot.sourceFile())] : [];
  });
}

function targetResult(
  lookups: readonly StringConstantLookups[],
  request: ImportedMemberRequest,
): StaticStringLookupResult {
  if (lookups.length !== 1) return {
    status: 'refused',
    reason: 'event_name_constant_container_ambiguous',
  };
  const key = request.memberName
    ? `${request.containerName}.${request.memberName}`
    : request.containerName;
  const constant = request.memberName
    ? lookups[0]?.enumMembers.get(key)
      ?? lookups[0]?.objectProperties.get(key)
    : lookups[0]?.identifiers.get(key);
  if (constant && constant.exported && constant.stable)
    return { status: 'resolved', constant };
  const refusal = lookups[0]?.refusedMembers.get(key);
  if (refusal) return { status: 'refused', reason: refusal.reason };
  if (constant && !constant.exported) return {
    status: 'refused',
    reason: 'event_name_constant_container_not_exported',
  };
  return {
    status: 'refused',
    reason: 'event_name_constant_member_not_string',
  };
}

export function createImportedEventNameResolver(
  context: RepositorySourceContext,
  source: ts.SourceFile,
  sourceFile: string,
): ImportedEventNameResolver {
  const bindings = collectSymbolImportBindings(source);
  return (expression): ImportedEventNameResult => {
    const request = importedMemberRequest(expression, bindings);
    if (!request) return unsupportedImportedContainer(expression, bindings)
      ? {
          status: 'refused',
          reason: 'event_name_constant_container_ambiguous',
        }
      : { status: 'not_found' };
    if (request.binding.moduleKind !== 'relative') {
      const packageImportReference = constantImportReference(request);
      return packageImportReference ? {
        status: 'refused',
        reason: 'event_name_constant_resolution_pending',
        packageImportReference,
      } : {
        status: 'refused',
        reason: 'event_name_constant_container_ambiguous',
      };
    }
    return targetResult(targetLookups(context, sourceFile, request), request);
  };
}
