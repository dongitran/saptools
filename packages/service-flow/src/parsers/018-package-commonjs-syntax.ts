import ts from 'typescript';
import {
  lexicalIdentifierDeclarations,
} from './002-symbol-import-bindings.js';

interface AccessPath {
  root: ts.Identifier;
  members: Array<string | null>;
}

function unwrap(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression))
    return unwrap(expression.expression);
  return expression;
}

function accessPath(expression: ts.Expression): AccessPath | undefined {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) return { root: value, members: [] };
  if (ts.isPropertyAccessExpression(value)) {
    const parent = accessPath(value.expression);
    return parent
      ? { root: parent.root, members: [...parent.members, value.name.text] }
      : undefined;
  }
  if (!ts.isElementAccessExpression(value)) return undefined;
  const parent = accessPath(value.expression);
  if (!parent) return undefined;
  const argument = value.argumentExpression;
  const member = argument && (ts.isStringLiteralLike(argument)
    || ts.isNumericLiteral(argument)) ? argument.text : null;
  return { root: parent.root, members: [...parent.members, member] };
}

export function isUnshadowedCommonJsExportExpression(
  expression: ts.Expression,
): boolean {
  const path = accessPath(expression);
  if (!path || lexicalIdentifierDeclarations(path.root).length > 0)
    return false;
  if (path.root.text === 'exports') return true;
  return path.root.text === 'module'
    && path.members.length > 0
    && (path.members[0] === 'exports' || path.members[0] === null);
}

function writeTargetContainsExport(expression: ts.Expression): boolean {
  const target = unwrap(expression);
  if (isUnshadowedCommonJsExportExpression(target)) return true;
  if (ts.isSpreadElement(target))
    return writeTargetContainsExport(target.expression);
  if (ts.isBinaryExpression(target)
    && target.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    return writeTargetContainsExport(target.left);
  if (ts.isArrayLiteralExpression(target))
    return target.elements.some((item) =>
      !ts.isOmittedExpression(item) && writeTargetContainsExport(item));
  if (!ts.isObjectLiteralExpression(target)) return false;
  return target.properties.some((property) => {
    if (ts.isShorthandPropertyAssignment(property))
      return isUnshadowedCommonJsExportExpression(property.name);
    if (ts.isSpreadAssignment(property))
      return writeTargetContainsExport(property.expression);
    return ts.isPropertyAssignment(property)
      && writeTargetContainsExport(property.initializer);
  });
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment
    && kind <= ts.SyntaxKind.LastAssignment;
}

export function unsupportedCommonJsMutation(
  statement: ts.ExpressionStatement,
): boolean {
  const expression = statement.expression;
  if (ts.isBinaryExpression(expression)
    && isAssignmentOperator(expression.operatorToken.kind))
    return expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
      ? writeTargetContainsExport(expression.left)
      : !isUnshadowedCommonJsExportExpression(expression.left)
        && writeTargetContainsExport(expression.left);
  if (ts.isDeleteExpression(expression))
    return writeTargetContainsExport(expression.expression);
  if (ts.isPrefixUnaryExpression(expression)
    || ts.isPostfixUnaryExpression(expression))
    return writeTargetContainsExport(expression.operand);
  return ts.isCallExpression(expression)
    && expression.arguments.some(writeTargetContainsExport);
}

function topLevelDirectAssignment(node: ts.BinaryExpression): boolean {
  return node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && isUnshadowedCommonJsExportExpression(node.left)
    && ts.isExpressionStatement(node.parent)
    && ts.isSourceFile(node.parent.parent);
}

function unsupportedBinaryNode(node: ts.Node): boolean {
  return ts.isBinaryExpression(node)
    && isAssignmentOperator(node.operatorToken.kind)
    && writeTargetContainsExport(node.left)
    && !topLevelDirectAssignment(node);
}

function unsupportedMutationNode(node: ts.Node): boolean {
  if (ts.isDeleteExpression(node))
    return writeTargetContainsExport(node.expression);
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
    return writeTargetContainsExport(node.operand);
  return ts.isCallExpression(node)
    && node.arguments.some(writeTargetContainsExport);
}

function unsupportedLoopNode(node: ts.Node): boolean {
  if (!ts.isForInStatement(node) && !ts.isForOfStatement(node))
    return false;
  return !ts.isVariableDeclarationList(node.initializer)
    && writeTargetContainsExport(node.initializer);
}

function unsupportedCommonJsNode(node: ts.Node): boolean {
  return unsupportedBinaryNode(node)
    || unsupportedMutationNode(node)
    || unsupportedLoopNode(node);
}

export function hasNestedCommonJsMutation(source: ts.SourceFile): boolean {
  let unsupported = false;
  const visit = (node: ts.Node): void => {
    if (unsupported) return;
    unsupported = unsupportedCommonJsNode(node);
    if (!unsupported) ts.forEachChild(node, visit);
  };
  visit(source);
  return unsupported;
}
