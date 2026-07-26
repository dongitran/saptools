import ts from 'typescript';
import {
  symbolCallName,
  type SymbolCallProxy,
  type SymbolClassInstance,
} from './009-symbol-call-facts.js';
import {
  identifierMatchesDeclaration,
  symbolImportReference,
  type SymbolImportBinding,
} from './002-symbol-import-bindings.js';

interface DerivedContextCollection {
  source: ts.SourceFile;
  importBindings: readonly SymbolImportBinding[];
  declaredClasses: ReadonlySet<string>;
  proxies: Map<string, SymbolCallProxy[]>;
  instances: Map<string, SymbolClassInstance[]>;
}

const builtInConstructors = new Set([
  'Set', 'Map', 'WeakSet', 'WeakMap',
  'Date', 'RegExp', 'URL', 'URLSearchParams',
  'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError',
  'TypeError', 'URIError', 'AggregateError',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array',
  'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array',
  'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'Promise', 'AbortController',
]);

function appendNamed<T>(
  values: Map<string, T[]>,
  name: string,
  value: T,
): void {
  const matches = values.get(name) ?? [];
  matches.push(value);
  values.set(name, matches);
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

function receiverIdentifier(
  expression: ts.Expression,
): ts.Identifier | undefined {
  let current = expression;
  while (ts.isPropertyAccessExpression(current)
    || ts.isElementAccessExpression(current))
    current = current.expression;
  return ts.isIdentifier(current) ? current : undefined;
}

function nodeWritesMember(
  node: ts.Node,
  matches: (expression: ts.Expression) => boolean,
): boolean {
  if (ts.isBinaryExpression(node))
    return assignmentOperator(node.operatorToken.kind) && matches(node.left);
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
    return mutationUnary(node) && matches(node.operand);
  return ts.isDeleteExpression(node) && matches(node.expression);
}

function memberWrite(
  source: ts.SourceFile,
  declaration: ts.Identifier,
): boolean {
  const start = declaration.getStart(source);
  const end = declaration.getEnd();
  const matches = (expression: ts.Expression): boolean => {
    const receiver = receiverIdentifier(expression);
    return Boolean(receiver && receiver !== expression
      && identifierMatchesDeclaration(receiver, start, end));
  };
  let written = false;
  const visit = (node: ts.Node): void => {
    if (written) return;
    written = nodeWritesMember(node, matches);
    if (!written) ts.forEachChild(node, visit);
  };
  visit(source);
  return written;
}

function stableVariable(
  collection: DerivedContextCollection,
  node: ts.VariableDeclaration,
): node is ts.VariableDeclaration & { name: ts.Identifier } {
  return ts.isIdentifier(node.name)
    && ts.isVariableDeclarationList(node.parent)
    && (node.parent.flags & ts.NodeFlags.Const) !== 0
    && !memberWrite(collection.source, node.name);
}

function collectProxy(
  collection: DerivedContextCollection,
  node: ts.Node,
): void {
  if (!ts.isVariableDeclaration(node) || !stableVariable(collection, node)
    || !node.initializer || !ts.isCallExpression(node.initializer)
    || !ts.isPropertyAccessExpression(node.initializer.expression)) return;
  const callee = symbolCallName(node.initializer.expression);
  const binding = symbolImportReference(
    node.initializer.expression, collection.importBindings,
  );
  if (!callee.member || !binding) return;
  appendNamed(collection.proxies, node.name.text, {
    importSource: binding.rawModuleSpecifier,
    importBinding: binding,
    factory: callee.expression,
    variableName: node.name.text,
    declarationStartOffset: node.name.getStart(collection.source),
    declarationEndOffset: node.name.getEnd(),
  });
}

function propertyContainer(
  declaration: ts.Identifier | ts.PropertyName,
  propertyName: string | undefined,
): ts.ClassLikeDeclaration | undefined {
  const property = propertyName && ts.isPropertyDeclaration(declaration.parent)
    ? declaration.parent : undefined;
  return property && ts.isClassLike(property.parent)
    ? property.parent : undefined;
}

function eligibleClassName(
  collection: DerivedContextCollection,
  className: string,
  imported: ReturnType<typeof symbolImportReference>,
): boolean {
  if (builtInConstructors.has(className)) return false;
  return Boolean(imported || collection.declaredClasses.has(className));
}

function resolvedClassName(
  className: string,
  imported: ReturnType<typeof symbolImportReference>,
): string {
  const importedName = imported?.importedName;
  return importedName && importedName !== 'default'
    ? importedName : className;
}

function rememberInstance(
  collection: DerivedContextCollection,
  declaration: ts.Identifier | ts.PropertyName,
  classExpression: ts.Identifier,
  propertyName?: string,
): void {
  const className = classExpression.text;
  const imported = symbolImportReference(
    classExpression, collection.importBindings,
  );
  if (!eligibleClassName(collection, className, imported)) return;
  const container = propertyContainer(declaration, propertyName);
  const variableName = propertyName
    ? `this.${propertyName}` : declaration.getText();
  appendNamed(collection.instances, variableName, {
    className: resolvedClassName(className, imported),
    importSource: imported?.rawModuleSpecifier,
    importBinding: imported,
    propertyName,
    declarationStartOffset: declaration.getStart(collection.source),
    declarationEndOffset: declaration.getEnd(),
    containerStartOffset: container?.getStart(collection.source),
    containerEndOffset: container?.getEnd(),
  });
}

function collectVariableInstance(
  collection: DerivedContextCollection,
  node: ts.Node,
): void {
  if (!ts.isVariableDeclaration(node) || !stableVariable(collection, node))
    return;
  const initializer = node.initializer;
  if (initializer && ts.isNewExpression(initializer)
    && ts.isIdentifier(initializer.expression))
    rememberInstance(collection, node.name, initializer.expression);
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name)
    || ts.isNumericLiteral(name) ? name.text : undefined;
}

function thisPropertyWrite(
  expression: ts.Expression,
  name: string,
): boolean {
  if (ts.isPropertyAccessExpression(expression))
    return expression.expression.kind === ts.SyntaxKind.ThisKeyword
      && expression.name.text === name;
  return ts.isElementAccessExpression(expression)
    && expression.expression.kind === ts.SyntaxKind.ThisKeyword
    && Boolean(expression.argumentExpression
      && ts.isStringLiteralLike(expression.argumentExpression)
      && expression.argumentExpression.text === name);
}

function nodeWritesThisProperty(
  node: ts.Node,
  name: string,
): boolean {
  if (ts.isBinaryExpression(node))
    return assignmentOperator(node.operatorToken.kind)
      && thisPropertyWrite(node.left, name);
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
    return mutationUnary(node) && thisPropertyWrite(node.operand, name);
  return ts.isDeleteExpression(node)
    && thisPropertyWrite(node.expression, name);
}

function stableProperty(
  node: ts.PropertyDeclaration,
  name: string,
): boolean {
  const flags = ts.getCombinedModifierFlags(node);
  if ((flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Readonly)) === 0
    || !ts.isClassLike(node.parent)) return false;
  let written = false;
  const visit = (child: ts.Node): void => {
    if (written || child === node) return;
    written = nodeWritesThisProperty(child, name);
    if (!written) ts.forEachChild(child, visit);
  };
  visit(node.parent);
  return !written;
}

function collectPropertyInstance(
  collection: DerivedContextCollection,
  node: ts.Node,
): void {
  if (!ts.isPropertyDeclaration(node)) return;
  const initializer = node.initializer;
  if (!initializer || !ts.isNewExpression(initializer)
    || !ts.isIdentifier(initializer.expression)) return;
  const name = propertyName(node.name);
  if (name && stableProperty(node, name)) rememberInstance(
    collection, node.name, initializer.expression, name,
  );
}

export function collectDerivedSymbolContexts(
  collection: DerivedContextCollection,
): void {
  const visit = (node: ts.Node): void => {
    collectProxy(collection, node);
    collectVariableInstance(collection, node);
    collectPropertyInstance(collection, node);
    ts.forEachChild(node, visit);
  };
  visit(collection.source);
}
