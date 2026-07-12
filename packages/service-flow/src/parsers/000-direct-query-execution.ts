import ts from 'typescript';

const capQueryBuilderRoots = new Set([
  'SELECT.from',
  'SELECT.one.from',
  'SELECT.one',
  'INSERT.into',
  'UPSERT.into',
  'UPDATE.entity',
  'UPDATE',
  'DELETE.from',
]);
const promiseValueShadowCache = new WeakMap<ts.SourceFile, boolean>();

export type DirectQueryExecutionContext =
  | 'await'
  | 'async_return'
  | 'promise_return'
  | 'promise_aggregate';

export interface DirectQueryBuilderStatement {
  root: ts.CallExpression;
  logicalCall: ts.CallExpression;
  statement: ts.Expression;
  executionContext: DirectQueryExecutionContext;
}

export function isCapQueryBuilderRootName(name: string): boolean {
  return capQueryBuilderRoots.has(name);
}

export function queryBuilderRoot(
  expression: ts.Expression,
): ts.CallExpression | undefined {
  const unwrapped = unwrapQueryExpression(expression);
  if (!ts.isCallExpression(unwrapped)) return undefined;
  if (isCapQueryBuilderRootName(expressionName(unwrapped.expression)))
    return unwrapped;
  return ts.isPropertyAccessExpression(unwrapped.expression)
    ? queryBuilderRoot(unwrapped.expression.expression)
    : undefined;
}

export function directQueryBuilderStatement(
  node: ts.CallExpression,
): DirectQueryBuilderStatement | undefined {
  const root = queryBuilderRoot(node);
  if (!root) return undefined;
  const logicalCall = outerFluentQueryCall(root);
  if (logicalCall !== node) return undefined;
  const expression = outerTransparentExpression(logicalCall);
  const awaitExpression = directAwaitExpression(expression);
  if (awaitExpression)
    return { root, logicalCall, statement: awaitExpression, executionContext: 'await' };
  const returnContext = returnExecutionContext(expression);
  if (returnContext)
    return { root, logicalCall, statement: expression, executionContext: returnContext };
  if (isAwaitedPromiseAllElement(expression))
    return { root, logicalCall, statement: expression, executionContext: 'promise_aggregate' };
  return undefined;
}

function expressionName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression))
    return `${expressionName(expression.expression)}.${expression.name.text}`;
  return expression.getText();
}

function unwrapQueryExpression(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression) || ts.isAwaitExpression(expression)
    || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression))
    return unwrapQueryExpression(expression.expression);
  return expression;
}

function wrapperParent(node: ts.Expression): ts.Expression | undefined {
  const parent = node.parent;
  if ((ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent)
    || ts.isTypeAssertionExpression(parent) || ts.isNonNullExpression(parent)
    || ts.isSatisfiesExpression(parent)) && parent.expression === node)
    return parent;
  return undefined;
}

function fluentCallParent(node: ts.Expression): ts.CallExpression | undefined {
  const property = node.parent;
  if (!ts.isPropertyAccessExpression(property) || property.expression !== node)
    return undefined;
  const call = property.parent;
  return ts.isCallExpression(call) && call.expression === property ? call : undefined;
}

function outerFluentQueryCall(root: ts.CallExpression): ts.CallExpression {
  let current: ts.Expression = root;
  let outer = root;
  while (true) {
    const wrapper = wrapperParent(current);
    if (wrapper) {
      current = wrapper;
      continue;
    }
    const next = fluentCallParent(current);
    if (!next) return outer;
    outer = next;
    current = next;
  }
}

function outerTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (true) {
    const wrapper = wrapperParent(current);
    if (!wrapper) return current;
    current = wrapper;
  }
}

function directAwaitExpression(
  expression: ts.Expression,
): ts.AwaitExpression | undefined {
  const parent = expression.parent;
  return ts.isAwaitExpression(parent) && parent.expression === expression
    ? parent
    : undefined;
}

function returnExecutionContext(
  expression: ts.Expression,
): DirectQueryExecutionContext | undefined {
  const callable = returnedExpressionCallable(expression);
  if (!callable) return undefined;
  if (hasAsyncModifier(callable)) return 'async_return';
  return hasGuaranteedPromiseReturn(callable) ? 'promise_return' : undefined;
}

function returnedExpressionCallable(
  expression: ts.Expression,
): ts.FunctionLikeDeclaration | undefined {
  const parent = expression.parent;
  if (ts.isArrowFunction(parent) && parent.body === expression) return parent;
  if (!ts.isReturnStatement(parent) || parent.expression !== expression)
    return undefined;
  return nearestCallable(parent);
}

function nearestCallable(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let current = node.parent;
  while (current) {
    if (isRuntimeCallable(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function isRuntimeCallable(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node);
}

function hasAsyncModifier(node: ts.Node): boolean {
  return !isGeneratorCallable(node) && ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
  ) ?? false);
}

function isGeneratorCallable(node: ts.Node): boolean {
  return (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
    || ts.isMethodDeclaration(node)) && Boolean(node.asteriskToken);
}

function hasGuaranteedPromiseReturn(
  callable: ts.FunctionLikeDeclaration,
): boolean {
  const returnType = declaredReturnType(callable);
  return Boolean(returnType && isGuaranteedPromiseType(returnType));
}

function declaredReturnType(
  callable: ts.FunctionLikeDeclaration,
): ts.TypeNode | undefined {
  if (ts.isFunctionDeclaration(callable) || ts.isFunctionExpression(callable)
    || ts.isArrowFunction(callable) || ts.isMethodDeclaration(callable))
    return callable.type;
  return undefined;
}

function isGuaranteedPromiseType(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type))
    return isGuaranteedPromiseType(type.type);
  if (ts.isTypeReferenceNode(type))
    return isStandardPromiseTypeName(type.typeName);
  if (ts.isUnionTypeNode(type))
    return type.types.length > 0 && type.types.every(isGuaranteedPromiseType);
  if (ts.isIntersectionTypeNode(type))
    return type.types.some(isGuaranteedPromiseType);
  return false;
}

function isStandardPromiseTypeName(name: ts.EntityName): boolean {
  if (ts.isIdentifier(name))
    return name.text === 'Promise' || name.text === 'PromiseLike';
  return ts.isIdentifier(name.left)
    && (name.left.text === 'globalThis' || name.left.text === 'global')
    && (name.right.text === 'Promise' || name.right.text === 'PromiseLike');
}

function isAwaitedPromiseAllElement(expression: ts.Expression): boolean {
  const array = directArrayParent(expression);
  if (!array) return false;
  const aggregate = aggregateCallForArray(array);
  return Boolean(aggregate && isBuiltInPromiseAll(aggregate)
    && directAwaitExpression(outerTransparentExpression(aggregate)));
}

function directArrayParent(
  expression: ts.Expression,
): ts.ArrayLiteralExpression | undefined {
  const parent = expression.parent;
  return ts.isArrayLiteralExpression(parent) && parent.elements.some(
    (element) => element === expression,
  ) ? parent : undefined;
}

function aggregateCallForArray(
  array: ts.ArrayLiteralExpression,
): ts.CallExpression | undefined {
  const argument = outerTransparentExpression(array);
  const parent = argument.parent;
  return ts.isCallExpression(parent) && parent.arguments.length === 1
    && parent.arguments[0] === argument ? parent : undefined;
}

function isBuiltInPromiseAll(call: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(call.expression)
    && ts.isIdentifier(call.expression.expression)
    && call.expression.expression.text === 'Promise'
    && call.expression.name.text === 'all'
    && !hasPromiseValueShadow(call.getSourceFile());
}

function hasPromiseValueShadow(source: ts.SourceFile): boolean {
  const cached = promiseValueShadowCache.get(source);
  if (cached !== undefined) return cached;
  let shadowed = false;
  const visit = (node: ts.Node): void => {
    if (shadowed) return;
    if (declaresPromiseValue(node)) {
      shadowed = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  promiseValueShadowCache.set(source, shadowed);
  return shadowed;
}

function declaresPromiseValue(node: ts.Node): boolean {
  if (ts.isVariableDeclaration(node) || ts.isParameter(node))
    return bindingNameIsPromise(node.name);
  if (ts.isImportClause(node))
    return !node.isTypeOnly && nodeIsPromise(node.name);
  if (ts.isImportSpecifier(node))
    return !node.isTypeOnly && nodeIsPromise(node.name);
  if (ts.isNamespaceImport(node) || ts.isImportEqualsDeclaration(node))
    return nodeIsPromise(node.name);
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
    || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node))
    return nodeIsPromise(node.name);
  return false;
}

function bindingNameIsPromise(name: ts.BindingName): boolean {
  if (ts.isIdentifier(name)) return name.text === 'Promise';
  if (ts.isObjectBindingPattern(name))
    return name.elements.some((element) => bindingNameIsPromise(element.name));
  return name.elements.some((element) => ts.isBindingElement(element)
    && bindingNameIsPromise(element.name));
}

function nodeIsPromise(name: ts.Node | undefined): boolean {
  return Boolean(name && ts.isIdentifier(name) && name.text === 'Promise');
}
