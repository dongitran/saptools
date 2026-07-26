import ts from 'typescript';
import {
  collectStringConstantLookups,
  type StaticStringConstant,
} from './string-constant-lookups.js';
import { resolveBinding } from './query-entity-resolution.js';
import { lexicalIdentifierDeclaration } from './symbol-import-bindings.js';

const loopValueCap = 32;
const loopExpressionLimit = 256;

function unwrap(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isTypeAssertionExpression(expression))
    return unwrap(expression.expression);
  return expression;
}

function stringArray(expression: ts.Expression): string[] | undefined {
  const value = unwrap(expression);
  if (!ts.isArrayLiteralExpression(value)) return undefined;
  const strings = value.elements.flatMap((element) => {
    const item = ts.isSpreadElement(element) ? undefined : unwrap(element);
    return item && ts.isStringLiteralLike(item) ? [item.text] : [];
  });
  return strings.length === value.elements.length ? strings : undefined;
}

function identifierArray(
  identifier: ts.Identifier,
): string[] | undefined {
  const binding = resolveBinding(identifier, identifier);
  return binding.immutable && binding.initializer
    ? stringArray(binding.initializer) : undefined;
}

function orderedValues(values: StaticStringConstant[]): string[] {
  return [...values]
    .sort((left, right) =>
      left.declarationStartOffset - right.declarationStartOffset)
    .map((item) => item.value);
}

function objectValues(
  expression: ts.CallExpression,
  source: ts.SourceFile,
): string[] | undefined {
  if (!ts.isPropertyAccessExpression(expression.expression))
    return undefined;
  const root = expression.expression.expression;
  if (!ts.isIdentifier(root) || root.text !== 'Object'
    || lexicalIdentifierDeclaration(root)
    || expression.expression.name.text !== 'values'
    || expression.arguments.length !== 1) return undefined;
  const argument = expression.arguments[0];
  if (!argument || !ts.isIdentifier(argument)) return undefined;
  const lookups = collectStringConstantLookups(source);
  const prefix = `${argument.text}.`;
  const refused = [...lookups.refusedMembers.keys()].some((key) =>
    key.startsWith(prefix));
  const values = [
    ...lookups.enumMembers.values(),
    ...lookups.objectProperties.values(),
  ].filter((item) => item.key.startsWith(prefix));
  return !refused && values.length > 0 ? orderedValues(values) : undefined;
}

function staticCollectionValues(
  expression: ts.Expression,
  source: ts.SourceFile,
): string[] | undefined {
  const value = unwrap(expression);
  if (ts.isArrayLiteralExpression(value)) return stringArray(value);
  if (ts.isIdentifier(value)) return identifierArray(value);
  return ts.isCallExpression(value) ? objectValues(value, source) : undefined;
}

function enclosingForEach(
  node: ts.Node,
): ts.CallExpression | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current))
      && ts.isCallExpression(current.parent)
      && current.parent.arguments.includes(current)
      && ts.isPropertyAccessExpression(current.parent.expression)
      && current.parent.expression.name.text === 'forEach')
      return current.parent;
    if (ts.isFunctionLike(current)) return undefined;
    current = current.parent;
  }
  return undefined;
}

function boundedExpression(
  expression: ts.Expression,
  source: ts.SourceFile,
): string {
  return expression.getText(source).slice(0, loopExpressionLimit);
}

export function eventLoopRegistrationEvidence(
  node: ts.CallExpression,
  source: ts.SourceFile,
): Record<string, unknown> {
  const loop = enclosingForEach(node);
  if (!loop || !ts.isPropertyAccessExpression(loop.expression)) return {};
  const collection = loop.expression.expression;
  const values = staticCollectionValues(collection, source);
  if (!values) return {
    subscriptionRegisteredInLoop: true,
    subscriptionLoopRegistrationStatus: 'unresolved',
    subscriptionLoopUnresolvedReason:
      'subscription_loop_collection_not_statically_enumerable',
    subscriptionLoopCollectionExpression:
      boundedExpression(collection, source),
  };
  const shown = values.slice(0, loopValueCap);
  return {
    subscriptionRegisteredInLoop: true,
    subscriptionLoopRegistrationStatus: 'enumerated',
    subscriptionLoopCollectionExpression:
      boundedExpression(collection, source),
    subscriptionLoopRegistrationCount: values.length,
    subscriptionLoopValues: shown,
    shownSubscriptionLoopValueCount: shown.length,
    omittedSubscriptionLoopValueCount:
      Math.max(0, values.length - shown.length),
  };
}
