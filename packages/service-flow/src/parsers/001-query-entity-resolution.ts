import ts from 'typescript';
import { isCapQueryBuilderRootName } from './000-direct-query-execution.js';

export interface BindingResolution {
  declaration?: ts.VariableDeclaration | ts.ParameterDeclaration;
  initializer?: ts.Expression;
  immutable: boolean;
  evidence: string[];
}

interface DestructuredBinding {
  declaration: ts.VariableDeclaration | ts.ParameterDeclaration;
  initializer?: ts.Expression;
  entityName: string;
}

export const maxAliasDepth = 5;
const cdsModelSpecifier = /^#cds-models(?:\/|$)/;
const modelNamespaceCache = new WeakMap<ts.SourceFile, Set<string>>();

export function expressionName(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr))
    return `${expressionName(expr.expression)}.${expr.name.text}`;
  return expr.getText();
}

export function variableInitializers(
  source: ts.SourceFile,
): Map<string, ts.Expression> {
  const initializers = new Map<string, ts.Expression>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)
      || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer)
        initializers.set(declaration.name.text, declaration.initializer);
    }
  }
  return initializers;
}

function unwrapQueryExpression(expr: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expr) || ts.isAwaitExpression(expr)
    || ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr)
    || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr))
    return unwrapQueryExpression(expr.expression);
  return expr;
}

function isFunctionLikeScope(node: ts.Node): boolean {
  return ts.isFunctionLike(node) || ts.isSourceFile(node);
}

function nodeContains(parent: ts.Node, child: ts.Node): boolean {
  const source = child.getSourceFile();
  return child.getStart(source) >= parent.getStart(source)
    && child.getEnd() <= parent.getEnd();
}

function isLoopInitializerScope(
  declaration: ts.VariableDeclaration,
  scope: ts.Node,
): boolean {
  const list = declaration.parent;
  return (ts.isForStatement(scope) && scope.initializer === list)
    || ((ts.isForInStatement(scope) || ts.isForOfStatement(scope))
      && scope.initializer === list);
}

function isLexicalScopeBoundary(
  node: ts.Node,
  declaration: ts.VariableDeclaration,
): boolean {
  return ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node)
    || ts.isCaseBlock(node) || isLoopInitializerScope(declaration, node)
    || isFunctionLikeScope(node);
}

function declarationScope(
  node: ts.VariableDeclaration | ts.ParameterDeclaration,
): ts.Node {
  if (ts.isParameter(node)) return node.parent;
  if (ts.isCatchClause(node.parent) && node.parent.variableDeclaration === node)
    return node.parent;
  const list = node.parent;
  const blockScoped = (list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) !== 0;
  let current: ts.Node = list.parent;
  if (!blockScoped) {
    while (current.parent && !isFunctionLikeScope(current)) current = current.parent;
    return current;
  }
  while (current.parent && !isLexicalScopeBoundary(current, node))
    current = current.parent;
  return current;
}

function catchBindingScope(
  declaration: ts.VariableDeclaration | ts.ParameterDeclaration,
): ts.CatchClause | undefined {
  if (ts.isParameter(declaration)) return undefined;
  return ts.isCatchClause(declaration.parent)
    && declaration.parent.variableDeclaration === declaration
    ? declaration.parent
    : undefined;
}

function declarationIsInScope(
  declaration: ts.VariableDeclaration | ts.ParameterDeclaration,
  use: ts.Node,
): boolean {
  const catchScope = catchBindingScope(declaration);
  if (catchScope) return nodeContains(catchScope.block, use);
  const scope = declarationScope(declaration);
  if (ts.isForStatement(scope) || ts.isForInStatement(scope)
    || ts.isForOfStatement(scope)) return nodeContains(scope.statement, use);
  return ts.isSourceFile(scope) || nodeContains(scope, use);
}

function isAccessibleDeclaration(
  declaration: ts.VariableDeclaration | ts.ParameterDeclaration,
  use: ts.Node,
): boolean {
  return declaration.name.getStart(use.getSourceFile()) < use.getStart()
    && declarationIsInScope(declaration, use);
}

export function resolveBinding(
  identifier: ts.Identifier,
  use: ts.Node,
): BindingResolution {
  const source = use.getSourceFile();
  let best: ts.VariableDeclaration | ts.ParameterDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.name.text === identifier.text && isAccessibleDeclaration(node, use))
      best = node;
    if (ts.isParameter(node) && ts.isIdentifier(node.name)
      && node.name.text === identifier.text && isAccessibleDeclaration(node, use))
      best = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!best) return { immutable: false, evidence: ['binding_not_found'] };
  const immutable = ts.isVariableDeclaration(best)
    && (best.parent.flags & ts.NodeFlags.Const) !== 0;
  return {
    declaration: best,
    initializer: ts.isVariableDeclaration(best) ? best.initializer : undefined,
    immutable,
    evidence: [immutable
      ? 'lexical_const_binding_before_use'
      : 'lexical_mutable_or_parameter_binding'],
  };
}

function directBindingElement(
  name: ts.BindingName,
  identifier: ts.Identifier,
): ts.BindingElement | undefined {
  if (ts.isIdentifier(name)) return undefined;
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element) || element.dotDotDotToken
      || element.initializer
      || !ts.isIdentifier(element.name)) continue;
    if (element.name.text === identifier.text) return element;
  }
  return undefined;
}

function bindingNameContains(name: ts.BindingName, target: string): boolean {
  if (ts.isIdentifier(name)) return name.text === target;
  return name.elements.some((element) => ts.isBindingElement(element)
    && bindingNameContains(element.name, target));
}

function bindingScope(node: ts.Node): ts.Node {
  if (ts.isVariableDeclaration(node) || ts.isParameter(node))
    return declarationScope(node);
  if (ts.isFunctionExpression(node) || ts.isClassExpression(node)) return node;
  return node.parent;
}

function bindingIsCloser(candidate: ts.Node, current: ts.Node, use: ts.Node): boolean {
  const source = use.getSourceFile();
  const candidateScope = bindingScope(candidate);
  const currentScope = bindingScope(current);
  const candidateSpan = candidateScope.getEnd() - candidateScope.getStart(source);
  const currentSpan = currentScope.getEnd() - currentScope.getStart(source);
  return candidateSpan < currentSpan
    || (candidateSpan === currentSpan
      && candidate.getStart(source) > current.getStart(source));
}

function nearestScopedVariableDeclaration(
  identifier: ts.Identifier,
): ts.VariableDeclaration | ts.ParameterDeclaration | undefined {
  let best: ts.VariableDeclaration | ts.ParameterDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node))
      && bindingNameContains(node.name, identifier.text)
      && declarationIsInScope(node, identifier)
      && (!best || bindingIsCloser(node, best, identifier))) best = node;
    ts.forEachChild(node, visit);
  };
  visit(identifier.getSourceFile());
  return best;
}

function hasScopedVariableDeclaration(identifier: ts.Identifier): boolean {
  return Boolean(nearestScopedVariableDeclaration(identifier));
}

function namedValueDeclarationMatches(
  node: ts.Node,
  name: string,
): boolean {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
    || ts.isEnumDeclaration(node)) return node.name?.text === name;
  return ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)
    && node.name.text === name;
}

function declarationContainerContains(node: ts.Node, use: ts.Node): boolean {
  const container = node.parent;
  return ts.isSourceFile(container)
    || ((ts.isBlock(container) || ts.isModuleBlock(container))
      && nodeContains(container, use));
}

function selfNamedValueDeclarationMatches(
  node: ts.Node,
  identifier: ts.Identifier,
): boolean {
  return (ts.isFunctionExpression(node) || ts.isClassExpression(node))
    && node.name?.text === identifier.text
    && nodeContains(node, identifier);
}

function scopedNonVariableDeclarationMatches(
  node: ts.Node,
  identifier: ts.Identifier,
): boolean {
  return (namedValueDeclarationMatches(node, identifier.text)
    && declarationContainerContains(node, identifier))
    || selfNamedValueDeclarationMatches(node, identifier);
}

function nearestScopedNonVariableDeclaration(
  identifier: ts.Identifier,
): ts.Node | undefined {
  let best: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (scopedNonVariableDeclarationMatches(node, identifier)
      && (!best || bindingIsCloser(node, best, identifier))) best = node;
    ts.forEachChild(node, visit);
  };
  visit(identifier.getSourceFile());
  return best;
}

function hasScopedNonVariableDeclaration(identifier: ts.Identifier): boolean {
  return Boolean(nearestScopedNonVariableDeclaration(identifier));
}

function nonVariableBindingWins(
  identifier: ts.Identifier,
  selected: ts.Node | undefined,
): boolean {
  const declaration = nearestScopedNonVariableDeclaration(identifier);
  return Boolean(declaration
    && (!selected || bindingIsCloser(declaration, selected, identifier)));
}

function importClauseBinds(
  clause: ts.ImportClause | undefined,
  name: string,
): boolean {
  if (!clause || clause.isTypeOnly) return false;
  if (clause.name?.text === name) return true;
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return bindings.name.text === name;
  return bindings.elements.some((element) => !element.isTypeOnly
    && element.name.text === name);
}

function hasValueImportBinding(identifier: ts.Identifier): boolean {
  return identifier.getSourceFile().statements.some((statement) => {
    if (ts.isImportDeclaration(statement))
      return importClauseBinds(statement.importClause, identifier.text);
    return ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly
      && statement.name.text === identifier.text;
  });
}

function sourcePropertyName(
  element: ts.BindingElement,
  localName: string,
): string | undefined {
  const property = element.propertyName;
  if (!property) return localName;
  if (ts.isIdentifier(property) || ts.isStringLiteral(property)
    || ts.isNumericLiteral(property)) return property.text;
  return undefined;
}

function resolveDestructuredBinding(
  identifier: ts.Identifier,
  use: ts.Node,
): DestructuredBinding | undefined {
  const source = use.getSourceFile();
  let best: DestructuredBinding | undefined;
  const visit = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node))
      && isAccessibleDeclaration(node, use)) {
      const element = directBindingElement(node.name, identifier);
      const entityName = element
        ? sourcePropertyName(element, identifier.text)
        : undefined;
      if (entityName && (!best || node.name.getStart(source)
        > best.declaration.name.getStart(source))) {
        best = {
          declaration: node,
          initializer: node.initializer,
          entityName,
        };
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return best;
}

function isEntitiesBase(expr: ts.Expression): boolean {
  const value = unwrapQueryExpression(expr);
  if (ts.isPropertyAccessExpression(value)) return value.name.text === 'entities';
  return ts.isCallExpression(value)
    && ts.isPropertyAccessExpression(value.expression)
    && value.expression.name.text === 'entities';
}

function hasLexicalValueShadow(
  identifier: ts.Identifier,
  includeImports: boolean,
): boolean {
  return hasScopedVariableDeclaration(identifier)
    || hasScopedNonVariableDeclaration(identifier)
    || (includeImports && hasValueImportBinding(identifier));
}

function modelRequire(expr: ts.Expression): boolean {
  const value = unwrapQueryExpression(expr);
  if (!ts.isCallExpression(value) || !ts.isIdentifier(value.expression)
    || value.expression.text !== 'require' || value.arguments.length !== 1)
    return false;
  if (hasLexicalValueShadow(value.expression, true)) return false;
  const specifier = value.arguments[0];
  return Boolean(specifier && ts.isStringLiteralLike(specifier)
    && cdsModelSpecifier.test(specifier.text));
}

function modelNamespaceImportName(
  statement: ts.Statement,
): string | undefined {
  if (!ts.isImportDeclaration(statement)
    || !ts.isStringLiteralLike(statement.moduleSpecifier)
    || !cdsModelSpecifier.test(statement.moduleSpecifier.text)
    || statement.importClause?.isTypeOnly) return undefined;
  const bindings = statement.importClause?.namedBindings;
  return bindings && ts.isNamespaceImport(bindings)
    ? bindings.name.text
    : undefined;
}

function modelImportEqualsName(
  statement: ts.Statement,
): string | undefined {
  if (!ts.isImportEqualsDeclaration(statement) || statement.isTypeOnly
    || !ts.isExternalModuleReference(statement.moduleReference)) return undefined;
  const specifier = statement.moduleReference.expression;
  return specifier && ts.isStringLiteralLike(specifier)
    && cdsModelSpecifier.test(specifier.text)
    ? statement.name.text
    : undefined;
}

function modelNamespaceNames(source: ts.SourceFile): Set<string> {
  const cached = modelNamespaceCache.get(source);
  if (cached) return cached;
  const names = new Set<string>();
  for (const statement of source.statements) {
    const name = modelNamespaceImportName(statement)
      ?? modelImportEqualsName(statement);
    if (name) names.add(name);
  }
  modelNamespaceCache.set(source, names);
  return names;
}

function destructuredEntitySource(
  initializer: ts.Expression | undefined,
): boolean {
  if (!initializer) return false;
  if (isEntitiesBase(initializer) || modelRequire(initializer)) return true;
  const value = unwrapQueryExpression(initializer);
  return ts.isIdentifier(value)
    && !hasLexicalValueShadow(value, false)
    && modelNamespaceNames(value.getSourceFile()).has(value.text);
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment
    && kind <= ts.SyntaxKind.LastAssignment;
}

function identifierIsReadWithinTarget(
  identifier: ts.Identifier,
  parent: ts.Node,
): boolean {
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return true;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression
    && nodeContains(parent.argumentExpression, identifier)) return true;
  if (ts.isPropertyAssignment(parent) && nodeContains(parent.name, identifier)) return true;
  return ts.isComputedPropertyName(parent) && nodeContains(parent.expression, identifier);
}

function identifierIsUnaryWrite(identifier: ts.Identifier): boolean {
  const direct = identifier.parent;
  if (!((ts.isPrefixUnaryExpression(direct) || ts.isPostfixUnaryExpression(direct))
    && direct.operand === identifier)) return false;
  return direct.operator === ts.SyntaxKind.PlusPlusToken
    || direct.operator === ts.SyntaxKind.MinusMinusToken;
}

function identifierIsNestedWrite(identifier: ts.Identifier): boolean {
  let current: ts.Node = identifier;
  while (current.parent) {
    const parent = current.parent;
    if (identifierIsReadWithinTarget(identifier, parent)) return false;
    if (ts.isBinaryExpression(parent))
      return isAssignmentOperator(parent.operatorToken.kind)
        && nodeContains(parent.left, identifier);
    if (ts.isForInStatement(parent) || ts.isForOfStatement(parent))
      return nodeContains(parent.initializer, identifier);
    current = parent;
  }
  return false;
}

function identifierIsWrite(identifier: ts.Identifier): boolean {
  return identifierIsUnaryWrite(identifier) || identifierIsNestedWrite(identifier);
}

function destructuredBindingWasWritten(
  binding: DestructuredBinding,
  localName: string,
  use: ts.Node,
): boolean {
  if (ts.isParameter(binding.declaration)) return true;
  if ((binding.declaration.parent.flags & ts.NodeFlags.Const) !== 0) return false;
  let written = false;
  const declarationEnd = binding.declaration.name.getEnd();
  const useStart = use.getStart();
  const visit = (node: ts.Node): void => {
    if (written) return;
    if (ts.isIdentifier(node) && node.text === localName
      && node.getStart() > declarationEnd && node.getStart() < useStart
      && identifierIsWrite(node)
      && resolveDestructuredBinding(node, node)?.declaration === binding.declaration)
      written = true;
    ts.forEachChild(node, visit);
  };
  visit(use.getSourceFile());
  return written;
}

function destructuredBindingWins(
  destructured: DestructuredBinding,
  simple: BindingResolution,
  use: ts.Node,
): boolean {
  return !simple.declaration
    || bindingIsCloser(destructured.declaration, simple.declaration, use);
}

function entityFromDestructuredBinding(
  binding: DestructuredBinding,
  identifier: ts.Identifier,
): string | undefined {
  if (destructuredBindingWasWritten(binding, identifier.text, identifier))
    return undefined;
  return destructuredEntitySource(binding.initializer)
    ? binding.entityName
    : undefined;
}

function entityFromSimpleBinding(
  binding: BindingResolution,
  depth: number,
  seen: Set<ts.Node>,
): string | undefined {
  if (!binding.declaration || !binding.immutable || !binding.initializer
    || seen.has(binding.declaration)) return undefined;
  seen.add(binding.declaration);
  return entityFromExpression(binding.initializer, depth + 1, seen);
}

function scopedBindingIsCurrent(
  identifier: ts.Identifier,
  declaration: ts.VariableDeclaration | ts.ParameterDeclaration,
): boolean {
  return nearestScopedVariableDeclaration(identifier) === declaration
    && !nonVariableBindingWins(identifier, declaration);
}

function unboundEntityName(identifier: ts.Identifier): string | undefined {
  return hasScopedVariableDeclaration(identifier)
    || hasScopedNonVariableDeclaration(identifier)
    ? undefined
    : identifier.text;
}

function entityFromIdentifier(
  expr: ts.Identifier,
  depth: number,
  seen: Set<ts.Node>,
): string | undefined {
  const binding = resolveBinding(expr, expr);
  const destructured = resolveDestructuredBinding(expr, expr);
  if (destructured && destructuredBindingWins(destructured, binding, expr)) {
    return scopedBindingIsCurrent(expr, destructured.declaration)
      ? entityFromDestructuredBinding(destructured, expr)
      : undefined;
  }
  if (!binding.declaration) return unboundEntityName(expr);
  if (!scopedBindingIsCurrent(expr, binding.declaration)) return undefined;
  return entityFromSimpleBinding(binding, depth, seen);
}

function literalEntity(expr: ts.Expression): string | undefined {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
    return expr.text;
  if (!ts.isElementAccessExpression(expr) || !expr.argumentExpression)
    return undefined;
  return ts.isStringLiteral(expr.argumentExpression)
    || ts.isNoSubstitutionTemplateLiteral(expr.argumentExpression)
    ? expr.argumentExpression.text
    : undefined;
}

function propertyEntity(expr: ts.Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(expr)) return undefined;
  if (expr.expression.kind === ts.SyntaxKind.ThisKeyword) return undefined;
  return isEntitiesBase(expr.expression) ? expr.name.text : undefined;
}

function entityFromExpression(
  expr: ts.Expression | undefined,
  depth = 0,
  seen = new Set<ts.Node>(),
): string | undefined {
  if (!expr || depth >= maxAliasDepth) return undefined;
  const value = unwrapQueryExpression(expr);
  const literal = literalEntity(value);
  if (literal !== undefined) return literal;
  if (ts.isIdentifier(value)) return entityFromIdentifier(value, depth, seen);
  return propertyEntity(value);
}

function queryAliasInitializer(
  identifier: ts.Identifier,
  initializers: Map<string, ts.Expression>,
  seen: Set<string>,
): ts.Expression | undefined {
  const initializer = initializers.get(identifier.text);
  if (!initializer || seen.has(identifier.text)) return undefined;
  const binding = resolveBinding(identifier, identifier);
  if (!binding.declaration || !binding.immutable || binding.initializer !== initializer
    || nearestScopedVariableDeclaration(identifier) !== binding.declaration
    || nonVariableBindingWins(identifier, binding.declaration)) return undefined;
  seen.add(identifier.text);
  return initializer;
}

function queryEntityFromCall(
  call: ts.CallExpression,
  initializers: Map<string, ts.Expression>,
  seenInitializers: Set<string>,
): string | undefined {
  const name = expressionName(call.expression);
  if (name === 'cds.run')
    return queryEntityFromAst(call.arguments[0], initializers, seenInitializers);
  if (isCapQueryBuilderRootName(name))
    return entityFromExpression(call.arguments[0]);
  const receiver = ts.isPropertyAccessExpression(call.expression)
    ? call.expression.expression
    : undefined;
  return receiver
    ? queryEntityFromAst(receiver, initializers, seenInitializers)
    : undefined;
}

export function queryEntityFromAst(
  expr: ts.Expression,
  initializers = new Map<string, ts.Expression>(),
  seenInitializers = new Set<string>(),
): string | undefined {
  const unwrapped = unwrapQueryExpression(expr);
  if (ts.isIdentifier(unwrapped)) {
    const initializer = queryAliasInitializer(
      unwrapped, initializers, seenInitializers,
    );
    return initializer
      ? queryEntityFromAst(initializer, initializers, seenInitializers)
      : undefined;
  }
  return ts.isCallExpression(unwrapped)
    ? queryEntityFromCall(unwrapped, initializers, seenInitializers)
    : undefined;
}
