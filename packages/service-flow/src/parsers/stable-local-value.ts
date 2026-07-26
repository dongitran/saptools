import ts from 'typescript';
import {
  identifierMatchesDeclaration,
} from './symbol-import-bindings.js';
import {
  isUnshadowedCommonJsExportExpression,
} from './package-commonjs-syntax.js';

function transparentUse(node: ts.Node): ts.Node {
  const parent = node.parent;
  if (parent && (ts.isParenthesizedExpression(parent)
    || ts.isAsExpression(parent)
    || ts.isSatisfiesExpression(parent)
    || ts.isTypeAssertionExpression(parent)
    || ts.isNonNullExpression(parent)))
    return transparentUse(parent);
  return node;
}

function assignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment
    && kind <= ts.SyntaxKind.LastAssignment;
}

function directWriteTarget(node: ts.Node): boolean {
  const use = transparentUse(node);
  const parent = use.parent;
  if (!parent) return false;
  if (ts.isBinaryExpression(parent))
    return parent.left === use && assignmentOperator(parent.operatorToken.kind);
  if (ts.isDeleteExpression(parent))
    return parent.expression === use;
  if (ts.isPrefixUnaryExpression(parent)
    || ts.isPostfixUnaryExpression(parent))
    return parent.operand === use;
  return (ts.isForInStatement(parent) || ts.isForOfStatement(parent))
    && parent.initializer === use;
}

type MemberContainer =
  | ts.ObjectLiteralExpression
  | ts.ClassLikeDeclaration
  | ts.EnumDeclaration;
type StableMember =
  | ts.ObjectLiteralElementLike
  | ts.ClassElement
  | ts.EnumMember;

function memberInitializer(
  expression: ts.Expression,
): ts.Expression {
  if (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isTypeAssertionExpression(expression))
    return memberInitializer(expression.expression);
  return expression;
}

function memberContainer(
  declaration: ts.Identifier,
): MemberContainer | undefined {
  const parent = declaration.parent;
  if (ts.isClassDeclaration(parent)) return parent;
  if (ts.isEnumDeclaration(parent)) return parent;
  if (!ts.isVariableDeclaration(parent) || parent.name !== declaration
    || !parent.initializer) return undefined;
  const initializer = memberInitializer(parent.initializer);
  return ts.isObjectLiteralExpression(initializer)
    || ts.isClassExpression(initializer)
    ? initializer
    : undefined;
}

function declaredMemberName(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node))
    return node.text;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

function accessedMemberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (!ts.isElementAccessExpression(node)) return undefined;
  const argument = node.argumentExpression;
  return argument && (ts.isStringLiteral(argument)
    || ts.isNoSubstitutionTemplateLiteral(argument))
    ? argument.text
    : undefined;
}

function memberName(node: ts.Node): string | undefined {
  return declaredMemberName(node) ?? accessedMemberName(node);
}

function matchingMember(
  value: MemberContainer,
  name: string,
): StableMember | undefined {
  const members = ts.isObjectLiteralExpression(value)
    ? value.properties
    : ts.isEnumDeclaration(value)
      ? value.members
      : value.members.filter((member) =>
        ts.canHaveModifiers(member)
        && ts.getModifiers(member)?.some((modifier) =>
          modifier.kind === ts.SyntaxKind.StaticKeyword));
  const matches = members.filter((member) =>
    'name' in member && member.name && memberName(member.name) === name);
  if (matches.length === 1) return matches[0];
  const implemented = matches.filter((member) => callableMember(member)?.body);
  return implemented.length === 1 ? implemented[0] : undefined;
}

function callableMember(
  member: StableMember,
): ts.FunctionLikeDeclaration | undefined {
  if (ts.isMethodDeclaration(member)) return member;
  if (ts.isPropertyAssignment(member)
    && (ts.isArrowFunction(member.initializer)
      || ts.isFunctionExpression(member.initializer)))
    return member.initializer;
  if (ts.isPropertyDeclaration(member) && member.initializer
    && (ts.isArrowFunction(member.initializer)
      || ts.isFunctionExpression(member.initializer)))
    return member.initializer;
  return undefined;
}

function containsThis(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (child.kind === ts.SyntaxKind.ThisKeyword) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function invokedMember(node: ts.Node): boolean {
  const use = transparentUse(node);
  const parent = use.parent;
  return Boolean(parent && ts.isCallExpression(parent)
    && parent.expression === use);
}

type MemberAccess = ts.PropertyAccessExpression | ts.ElementAccessExpression;

function receiverAccess(
  node: ts.Node,
): MemberAccess | undefined {
  const parent = node.parent;
  if (!parent || (!ts.isPropertyAccessExpression(parent)
    && !ts.isElementAccessExpression(parent))
    || parent.expression !== node || directWriteTarget(parent)) return undefined;
  return parent;
}

function stableMemberUse(
  access: MemberAccess,
  member: StableMember,
): boolean {
  if (!invokedMember(access)) return !ts.isGetAccessor(member)
    && !ts.isSetAccessor(member);
  const callable = callableMember(member);
  return Boolean(callable && !containsThis(callable));
}

function memberReceiverUse(
  node: ts.Node,
  declaration: ts.Identifier,
): boolean {
  const access = receiverAccess(node);
  if (!access) return false;
  const name = memberName(access);
  const value = memberContainer(declaration);
  const member = name && value ? matchingMember(value, name) : undefined;
  return member ? stableMemberUse(access, member) : false;
}

function commonJsExportUse(node: ts.Node): boolean {
  const parent = node.parent;
  return Boolean(parent && ts.isBinaryExpression(parent)
    && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && parent.right === node
    && isUnshadowedCommonJsExportExpression(parent.left)
    && ts.isExpressionStatement(parent.parent)
    && ts.isSourceFile(parent.parent.parent));
}

function esmExportUse(node: ts.Node): boolean {
  const parent = node.parent;
  return Boolean(parent && (ts.isExportSpecifier(parent)
    || (ts.isExportAssignment(parent) && parent.expression === node)));
}

function inertUnaryUse(node: ts.Node): boolean {
  const parent = node.parent;
  return Boolean(parent && ((ts.isVoidExpression(parent)
    || ts.isTypeOfExpression(parent)) && parent.expression === node));
}

function safeReferenceUse(
  node: ts.Identifier,
  declaration: ts.Identifier,
): boolean {
  const use = transparentUse(node);
  return memberReceiverUse(use, declaration)
    || commonJsExportUse(use)
    || esmExportUse(use)
    || inertUnaryUse(use);
}

export function stableLocalValueReference(
  source: ts.SourceFile,
  declaration: ts.Identifier,
): boolean {
  const start = declaration.getStart(source);
  const end = declaration.getEnd();
  let stable = true;
  const visit = (node: ts.Node): void => {
    if (!stable) return;
    if (ts.isIdentifier(node) && node !== declaration
      && identifierMatchesDeclaration(node, start, end)
      && !safeReferenceUse(node, declaration)) {
      stable = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return stable;
}
