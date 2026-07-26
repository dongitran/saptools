import ts from 'typescript';
import type { ExecutableSymbolFact } from '../types.js';
import {
  lexicalIdentifierDeclaration,
  lexicalIdentifierDeclarations,
} from './002-symbol-import-bindings.js';
import { stableLocalValueReference } from './020-stable-local-value.js';

export interface LocalSymbolTargetIdentity {
  sourceFile: string;
  qualifiedName: string;
  startOffset: number;
  endOffset: number;
}

function functionTargetNode(
  declaration: ts.Identifier,
): ts.Node | undefined {
  const parent = declaration.parent;
  if (ts.isFunctionDeclaration(parent)) return parent;
  if (!ts.isVariableDeclaration(parent)) return undefined;
  const initializer = parent.initializer;
  return initializer
    && (ts.isArrowFunction(initializer)
      || ts.isFunctionExpression(initializer))
    ? initializer
    : undefined;
}

function declarationKey(identifier: ts.Identifier): string {
  return `${identifier.getStart(identifier.getSourceFile())}:${identifier.getEnd()}`;
}

function unwrapAssignmentTarget(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression))
    return unwrapAssignmentTarget(expression.expression);
  return expression;
}

function objectAssignmentTargets(
  expression: ts.ObjectLiteralExpression,
): ts.Identifier[] {
  return expression.properties.flatMap((property) => {
    if (ts.isShorthandPropertyAssignment(property)) return [property.name];
    if (ts.isPropertyAssignment(property))
      return assignmentTargets(property.initializer);
    return ts.isSpreadAssignment(property)
      ? assignmentTargets(property.expression) : [];
  });
}

function assignmentTargets(expression: ts.Expression): ts.Identifier[] {
  const target = unwrapAssignmentTarget(expression);
  if (ts.isIdentifier(target)) return [target];
  if (ts.isSpreadElement(target))
    return assignmentTargets(target.expression);
  if (ts.isBinaryExpression(target)
    && target.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    return assignmentTargets(target.left);
  if (ts.isArrayLiteralExpression(target))
    return target.elements.flatMap((item) =>
      ts.isExpression(item) ? assignmentTargets(item) : []);
  return ts.isObjectLiteralExpression(target)
    ? objectAssignmentTargets(target) : [];
}

function assignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment
    && kind <= ts.SyntaxKind.LastAssignment;
}

function mutationUnary(
  node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
): boolean {
  return node.operator === ts.SyntaxKind.PlusPlusToken
    || node.operator === ts.SyntaxKind.MinusMinusToken;
}

type DeclarationMatcher = (identifier: ts.Identifier) => boolean;

function binaryWritesDeclaration(
  node: ts.Node,
  matches: DeclarationMatcher,
): boolean {
  if (!ts.isBinaryExpression(node)
    || !assignmentOperator(node.operatorToken.kind)) return false;
  return assignmentTargets(node.left).some(matches);
}

function unaryWritesDeclaration(
  node: ts.Node,
  matches: DeclarationMatcher,
): boolean {
  if (!ts.isPrefixUnaryExpression(node)
    && !ts.isPostfixUnaryExpression(node)) return false;
  return mutationUnary(node)
    && ts.isIdentifier(node.operand)
    && matches(node.operand);
}

function loopWritesDeclaration(
  node: ts.Node,
  matches: DeclarationMatcher,
): boolean {
  if (!ts.isForInStatement(node) && !ts.isForOfStatement(node)) return false;
  return !ts.isVariableDeclarationList(node.initializer)
    && assignmentTargets(node.initializer).some(matches);
}

function declarationWritten(
  source: ts.SourceFile,
  declarations: readonly ts.Identifier[],
): boolean {
  const keys = new Set(declarations.map(declarationKey));
  let written = false;
  const matches = (identifier: ts.Identifier): boolean =>
    lexicalIdentifierDeclarations(identifier)
      .some((item) => keys.has(declarationKey(item)));
  const visit = (node: ts.Node): void => {
    if (written) return;
    written = binaryWritesDeclaration(node, matches)
      || unaryWritesDeclaration(node, matches)
      || loopWritesDeclaration(node, matches);
    if (!written) ts.forEachChild(node, visit);
  };
  visit(source);
  return written;
}

function singleImmutableDeclaration(
  declaration: ts.Identifier | undefined,
): boolean {
  const parent = declaration?.parent;
  if (parent && ts.isClassDeclaration(parent)) return true;
  return Boolean(parent && ts.isVariableDeclaration(parent)
    && ts.isVariableDeclarationList(parent.parent)
    && (parent.parent.flags & ts.NodeFlags.Const) !== 0);
}

function immutableDeclarationSet(
  declarations: readonly ts.Identifier[],
  source: ts.SourceFile,
): boolean {
  if (declarations.length === 0
    || declarationWritten(source, declarations)) return false;
  if (declarations.every((item) => ts.isFunctionDeclaration(item.parent)))
    return true;
  if (declarations.length !== 1) return false;
  return singleImmutableDeclaration(declarations[0]);
}

function propertyContainer(
  declaration: ts.Identifier,
): ts.Node | undefined {
  const parent = declaration.parent;
  if (ts.isClassDeclaration(parent)) return parent;
  if (!ts.isVariableDeclaration(parent)) return undefined;
  const initializer = parent.initializer;
  return initializer
    && (ts.isObjectLiteralExpression(initializer)
      || ts.isClassExpression(initializer))
    ? initializer
    : undefined;
}

function identity(
  symbol: ExecutableSymbolFact,
): LocalSymbolTargetIdentity {
  return {
    sourceFile: symbol.sourceFile,
    qualifiedName: symbol.qualifiedName,
    startOffset: symbol.startOffset,
    endOffset: symbol.endOffset,
  };
}

function executableBody(symbol: ExecutableSymbolFact): boolean {
  const value = symbol.importExportEvidence?.executableBodyEligibility;
  return Boolean(value && typeof value === 'object'
    && !Array.isArray(value)
    && 'eligible' in value
    && value.eligible === true);
}

function exactFunctionTarget(
  declarations: readonly ts.Identifier[],
  symbols: readonly ExecutableSymbolFact[],
  source: ts.SourceFile,
): LocalSymbolTargetIdentity | undefined {
  if (!immutableDeclarationSet(declarations, source)) return undefined;
  const spans = declarations.flatMap((declaration) => {
    const target = functionTargetNode(declaration);
    return target
      ? [{ start: target.getStart(source), end: target.getEnd() }]
      : [];
  });
  const matches = symbols.filter((symbol) =>
    localFunctionMatches(symbol, spans, source.fileName));
  return matches.length === 1 && matches[0]
    ? identity(matches[0])
    : undefined;
}

function localFunctionMatches(
  symbol: ExecutableSymbolFact,
  spans: readonly { start: number; end: number }[],
  sourceFile: string,
): boolean {
  if (symbol.sourceFile !== sourceFile || !executableBody(symbol))
    return false;
  return spans.some((span) =>
    symbol.startOffset === span.start && symbol.endOffset === span.end);
}

function exactPropertyTarget(
  expression: ts.PropertyAccessExpression,
  declaration: ts.Identifier,
  symbols: readonly ExecutableSymbolFact[],
  source: ts.SourceFile,
): LocalSymbolTargetIdentity | undefined {
  if (!immutableDeclarationSet([declaration], source)
    || !stableLocalValueReference(source, declaration))
    return undefined;
  const container = propertyContainer(declaration);
  if (!container) return undefined;
  const qualifiedName = `${declaration.text}.${expression.name.text}`;
  const start = container.getStart(source);
  const end = container.getEnd();
  const matches = symbols.filter((symbol) =>
    symbol.sourceFile === source.fileName
    && symbol.qualifiedName === qualifiedName
    && symbol.startOffset >= start
    && symbol.endOffset <= end
    && executableBody(symbol));
  return matches.length === 1 && matches[0]
    ? identity(matches[0])
    : undefined;
}

export function localSymbolTarget(
  expression: ts.Expression,
  source: ts.SourceFile,
  symbols: readonly ExecutableSymbolFact[],
): LocalSymbolTargetIdentity | undefined {
  if (ts.isIdentifier(expression)) {
    return exactFunctionTarget(
      lexicalIdentifierDeclarations(expression), symbols, source,
    );
  }
  if (!ts.isPropertyAccessExpression(expression)
    || expression.questionDotToken
    || !ts.isIdentifier(expression.expression)) return undefined;
  const declaration = lexicalIdentifierDeclaration(expression.expression);
  return declaration
    ? exactPropertyTarget(expression, declaration, symbols, source)
    : undefined;
}
