import ts from 'typescript';
import { stableLocalValueReference } from './stable-local-value.js';
import { lexicalIdentifierDeclaration } from './symbol-import-bindings.js';

export type StaticStringConstantKind =
  | 'const_identifier'
  | 'enum_member'
  | 'const_object_property';

export interface StaticStringConstant {
  key: string;
  value: string;
  kind: StaticStringConstantKind;
  containerName?: string;
  memberName?: string;
  sourceFile: string;
  declarationStartOffset: number;
  declarationEndOffset: number;
  valueStartOffset: number;
  valueEndOffset: number;
  exported: boolean;
  stable: boolean;
}

export interface StaticStringRefusal {
  key: string;
  kind: StaticStringConstantKind;
  containerName?: string;
  memberName?: string;
  sourceFile: string;
  declarationStartOffset: number;
  declarationEndOffset: number;
  exported: boolean;
  stable: boolean;
  reason: 'event_name_constant_member_not_string'
    | 'event_name_constant_container_mutable'
    | 'event_name_constant_container_unsafe_reference'
    | 'event_name_constant_container_unsupported_shape';
}

export interface StringConstantLookups {
  identifiers: Map<string, StaticStringConstant>;
  enumMembers: Map<string, StaticStringConstant>;
  objectProperties: Map<string, StaticStringConstant>;
  refusedMembers: Map<string, StaticStringRefusal>;
}

export type StaticStringLookupResult =
  | { status: 'resolved'; constant: StaticStringConstant }
  | { status: 'refused'; reason: string }
  | { status: 'not_found' };

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isTypeAssertionExpression(expression))
    return unwrapExpression(expression.expression);
  return expression;
}

function stringValue(
  expression: ts.Expression | undefined,
): { value: string; node: ts.Expression } | undefined {
  if (!expression) return undefined;
  const value = unwrapExpression(expression);
  return ts.isStringLiteralLike(value)
    ? { value: value.text, node: value } : undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name)
    || ts.isNumericLiteral(name) ? name.text : undefined;
}

function exportedNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier
      || !statement.exportClause
      || !ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements)
      names.add(element.propertyName?.text ?? element.name.text);
  }
  return names;
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && Boolean(ts.getModifiers(node)?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function staticFact(
  source: ts.SourceFile,
  key: string,
  value: { value: string; node: ts.Expression },
  declaration: ts.Node,
  fields: Pick<StaticStringConstant, 'kind' | 'exported' | 'stable'>
    & Partial<Pick<StaticStringConstant, 'containerName' | 'memberName'>>,
): StaticStringConstant {
  return {
    key,
    value: value.value,
    sourceFile: source.fileName,
    declarationStartOffset: declaration.getStart(source),
    declarationEndOffset: declaration.getEnd(),
    valueStartOffset: value.node.getStart(source),
    valueEndOffset: value.node.getEnd(),
    ...fields,
  };
}

function refusalFact(
  source: ts.SourceFile,
  key: string,
  declaration: ts.Node,
  fields: Pick<StaticStringRefusal,
    'kind' | 'exported' | 'stable' | 'reason'>
    & Partial<Pick<StaticStringRefusal, 'containerName' | 'memberName'>>,
): StaticStringRefusal {
  return {
    key,
    sourceFile: source.fileName,
    declarationStartOffset: declaration.getStart(source),
    declarationEndOffset: declaration.getEnd(),
    ...fields,
  };
}

function collectEnum(
  source: ts.SourceFile,
  statement: ts.EnumDeclaration,
  exports: Set<string>,
  lookups: StringConstantLookups,
  qualifiedName = statement.name.text,
  qualifiedExported?: boolean,
): void {
  const stable = stableLocalValueReference(source, statement.name);
  const exported = qualifiedExported ?? (
    hasExportModifier(statement) || exports.has(statement.name.text)
  );
  for (const member of statement.members) {
    const memberName = propertyName(member.name);
    if (!memberName) continue;
    const key = `${qualifiedName}.${memberName}`;
    const value = stringValue(member.initializer);
    if (!stable) lookups.refusedMembers.set(key, refusalFact(
      source, key, member, {
        kind: 'enum_member', containerName: qualifiedName,
        memberName, exported, stable,
        reason: 'event_name_constant_container_unsafe_reference',
      },
    ));
    else if (!value) lookups.refusedMembers.set(key, refusalFact(
      source, key, member, {
        kind: 'enum_member', containerName: qualifiedName,
        memberName, exported, stable,
        reason: 'event_name_constant_member_not_string',
      },
    ));
    else lookups.enumMembers.set(key, staticFact(
      source, key, value, member, {
        kind: 'enum_member',
        containerName: qualifiedName,
        memberName,
        exported,
        stable,
      },
    ));
  }
}

function collectNestedNamespaceEnums(
  source: ts.SourceFile,
  module: ts.ModuleDeclaration,
  prefix: string,
  parentExported: boolean,
  lookups: StringConstantLookups,
): void {
  const currentName = ts.isIdentifier(module.name)
    || ts.isStringLiteral(module.name) ? module.name.text : undefined;
  if (!currentName) return;
  const qualified = prefix ? `${prefix}.${currentName}` : currentName;
  const exported = parentExported;
  if (module.body && ts.isModuleDeclaration(module.body)) {
    collectNestedNamespaceEnums(
      source, module.body, qualified,
      exported && hasExportModifier(module.body), lookups,
    );
    return;
  }
  const statements = module.body && ts.isModuleBlock(module.body)
    ? module.body.statements : [];
  for (const statement of statements) {
    if (ts.isEnumDeclaration(statement))
      collectEnum(
        source, statement, new Set(), lookups,
        `${qualified}.${statement.name.text}`,
        exported && hasExportModifier(statement),
      );
    if (ts.isModuleDeclaration(statement))
      collectNestedNamespaceEnums(
        source, statement, qualified,
        exported && hasExportModifier(statement), lookups,
      );
  }
}

function objectLiteral(
  expression: ts.Expression,
): ts.ObjectLiteralExpression | undefined {
  const value = unwrapExpression(expression);
  return ts.isObjectLiteralExpression(value) ? value : undefined;
}

function objectMemberName(
  property: ts.ObjectLiteralElementLike,
): string | undefined {
  if (ts.isSpreadAssignment(property)) return undefined;
  return property.name ? propertyName(property.name) : undefined;
}

function supportedObjectShape(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.every((property) =>
    ts.isPropertyAssignment(property)
    && propertyName(property.name) !== undefined);
}

function refuseObjectShape(
  source: ts.SourceFile,
  object: ts.ObjectLiteralExpression,
  declaration: ts.VariableDeclaration,
  exported: boolean,
  lookups: StringConstantLookups,
): void {
  if (!ts.isIdentifier(declaration.name)) return;
  for (const property of object.properties) {
    const memberName = objectMemberName(property);
    if (!memberName) continue;
    const key = `${declaration.name.text}.${memberName}`;
    lookups.refusedMembers.set(key, refusalFact(
      source, key, property, {
        kind: 'const_object_property',
        containerName: declaration.name.text,
        memberName,
        exported,
        stable: false,
        reason: 'event_name_constant_container_unsupported_shape',
      },
    ));
  }
}

function collectObject(
  source: ts.SourceFile,
  statement: ts.VariableStatement,
  declaration: ts.VariableDeclaration,
  exports: Set<string>,
  lookups: StringConstantLookups,
): void {
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return;
  const object = objectLiteral(declaration.initializer);
  if (!object) return;
  const stable = stableLocalValueReference(source, declaration.name);
  const exported = hasExportModifier(statement)
    || exports.has(declaration.name.text);
  if (!supportedObjectShape(object)) {
    refuseObjectShape(source, object, declaration, exported, lookups);
    return;
  }
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property))
      collectObjectProperty(
        source, property, declaration.name.text, exported, stable, lookups,
      );
  }
}

function collectObjectProperty(
  source: ts.SourceFile,
  property: ts.PropertyAssignment,
  containerName: string,
  exported: boolean,
  stable: boolean,
  lookups: StringConstantLookups,
): void {
  const memberName = propertyName(property.name);
  if (!memberName) return;
  const key = `${containerName}.${memberName}`;
  const value = stringValue(property.initializer);
  if (!stable || !value) {
    lookups.refusedMembers.set(key, refusalFact(
      source, key, property, {
        kind: 'const_object_property', containerName, memberName,
        exported, stable,
        reason: stable
          ? 'event_name_constant_member_not_string'
          : 'event_name_constant_container_unsafe_reference',
      },
    ));
    return;
  }
  lookups.objectProperties.set(key, staticFact(
    source, key, value, property, {
      kind: 'const_object_property', containerName, memberName,
      exported, stable,
    },
  ));
}

function collectIdentifier(
  source: ts.SourceFile,
  statement: ts.VariableStatement,
  declaration: ts.VariableDeclaration,
  exports: Set<string>,
  lookups: StringConstantLookups,
): void {
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return;
  const value = stringValue(declaration.initializer);
  if (!value) return;
  const key = declaration.name.text;
  lookups.identifiers.set(key, staticFact(
    source, key, value, declaration, {
      kind: 'const_identifier',
      exported: hasExportModifier(statement) || exports.has(key),
      stable: true,
    },
  ));
}

export function collectStringConstantLookups(
  source: ts.SourceFile,
): StringConstantLookups {
  const cached = stringLookupCache.get(source);
  if (cached) return cached;
  const lookups: StringConstantLookups = {
    identifiers: new Map(),
    enumMembers: new Map(),
    objectProperties: new Map(),
    refusedMembers: new Map(),
  };
  const exports = exportedNames(source);
  for (const statement of source.statements) {
    if (ts.isEnumDeclaration(statement))
      collectEnum(source, statement, exports, lookups);
    if (ts.isModuleDeclaration(statement))
      collectNestedNamespaceEnums(
        source, statement, '', hasExportModifier(statement)
          || exports.has(statement.name.getText(source)),
        lookups,
      );
    if (!ts.isVariableStatement(statement)
      || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      collectIdentifier(source, statement, declaration, exports, lookups);
      collectObject(source, statement, declaration, exports, lookups);
    }
  }
  stringLookupCache.set(source, lookups);
  return lookups;
}

const stringLookupCache =
  new WeakMap<ts.SourceFile, StringConstantLookups>();

export function resolveStringConstant(
  expression: ts.Expression,
  lookups: StringConstantLookups,
): StaticStringLookupResult {
  const value = unwrapExpression(expression);
  if (ts.isIdentifier(value)) {
    const constant = lookups.identifiers.get(value.text);
    return constant && constantReferenceMatches(value, constant)
      ? { status: 'resolved', constant } : { status: 'not_found' };
  }
  if (ts.isElementAccessExpression(value)
    && ts.isIdentifier(value.expression)) {
    const prefix = `${value.expression.text}.`;
    const known = [
      ...lookups.enumMembers.keys(),
      ...lookups.objectProperties.keys(),
      ...lookups.refusedMembers.keys(),
    ].some((key) => key.startsWith(prefix));
    return known && constantContainerMatches(
      value.expression, lookups, prefix,
    ) ? {
      status: 'refused',
      reason: 'event_name_constant_container_ambiguous',
    } : { status: 'not_found' };
  }
  if (!ts.isPropertyAccessExpression(value)
    || value.questionDotToken || !ts.isIdentifier(value.expression))
    return { status: 'not_found' };
  const key = `${value.expression.text}.${value.name.text}`;
  const constant = lookups.enumMembers.get(key)
    ?? lookups.objectProperties.get(key);
  if (constant && constantReferenceMatches(value.expression, constant))
    return { status: 'resolved', constant };
  const reason = lookups.refusedMembers.get(key);
  return reason && refusalReferenceMatches(value.expression, reason)
    ? { status: 'refused', reason: reason.reason }
    : constant || reason ? {
        status: 'refused',
        reason: 'event_name_constant_container_ambiguous',
      } : { status: 'not_found' };
}

function declarationContains(
  identifier: ts.Identifier,
  startOffset: number,
  endOffset: number,
): boolean {
  const declaration = lexicalIdentifierDeclaration(identifier);
  if (!declaration) return false;
  const owner = declaration.parent;
  return owner.getSourceFile() === identifier.getSourceFile()
    && owner.getStart(identifier.getSourceFile()) <= startOffset
    && owner.getEnd() >= endOffset;
}

function constantReferenceMatches(
  identifier: ts.Identifier,
  constant: StaticStringConstant,
): boolean {
  return declarationContains(
    identifier,
    constant.declarationStartOffset,
    constant.declarationEndOffset,
  );
}

function refusalReferenceMatches(
  identifier: ts.Identifier,
  refusal: StaticStringRefusal,
): boolean {
  return declarationContains(
    identifier,
    refusal.declarationStartOffset,
    refusal.declarationEndOffset,
  );
}

function constantContainerMatches(
  identifier: ts.Identifier,
  lookups: StringConstantLookups,
  prefix: string,
): boolean {
  const constants = [
    ...lookups.enumMembers.values(),
    ...lookups.objectProperties.values(),
  ].filter((item) => item.key.startsWith(prefix));
  const refusals = [...lookups.refusedMembers.values()]
    .filter((item) => item.key.startsWith(prefix));
  return [...constants, ...refusals].some((item) =>
    declarationContains(
      identifier, item.declarationStartOffset, item.declarationEndOffset,
    ));
}
