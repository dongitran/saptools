import ts from 'typescript';
import {
  connectFactFromCall,
  transactionReceiverName,
  unwrapCall,
  unwrapIdentityExpression,
  type HelperBinding,
} from './service-binding-parser-helpers.js';
import {
  createBindingLexicalIndex,
  type BindingLexicalIndex,
  type BindingSiteCandidate,
  type VisibleBinding,
} from './binding-lexical-scope.js';
import { bindingAssignmentEntries } from
  './binding-assignment-targets.js';
import { selectVisibleBinding } from './binding-visibility.js';

export type LocalBindingFact = Omit<
  HelperBinding,
  'exportedName' | 'sourceFile' | 'sourceLine'
>;

export function directConnectFact(
  expression: ts.Expression,
): LocalBindingFact | undefined {
  const call = unwrapCall(expression);
  return call ? connectFactFromCall(call) : undefined;
}

export function bindingValueAtSite<T>(
  variableName: string,
  node: ts.Node,
  source: ts.SourceFile,
  value: T,
): BindingSiteCandidate<T> {
  return {
    variableName,
    bindingSiteStartOffset: node.getStart(source),
    bindingSiteEndOffset: node.getEnd(),
    value,
  };
}

export function arrayBindingName(
  element: ts.ArrayBindingElement | undefined,
): string | undefined {
  return element && ts.isBindingElement(element)
    && !element.dotDotDotToken && ts.isIdentifier(element.name)
    ? element.name.text
    : undefined;
}

export function arrayAssignmentName(
  element: ts.Expression | undefined,
): string | undefined {
  return element && !ts.isOmittedExpression(element)
    && !ts.isSpreadElement(element) && ts.isIdentifier(element)
    ? element.text
    : undefined;
}

function deterministicLocalSource(
  selected: VisibleBinding<LocalBindingFact>,
): LocalBindingFact | undefined {
  if (selected.status !== 'resolved') return undefined;
  if (!selected.site?.deterministic) return undefined;
  if (selected.declarationSite?.declarationKind === 'var') return undefined;
  return selected.candidate?.value;
}

function aliasLocalFact(
  sourceName: string,
  targetName: string,
  node: ts.Node,
  index: BindingLexicalIndex,
  bindings: readonly BindingSiteCandidate<LocalBindingFact>[],
  transaction: boolean,
): BindingSiteCandidate<LocalBindingFact> | undefined {
  const source = deterministicLocalSource(
    selectVisibleBinding(index, bindings, sourceName, node),
  );
  if (!source) return undefined;
  const helperChain = [...(source.helperChain ?? []), {
    aliasOf: sourceName,
    callerVariable: targetName,
    aliasKind: transaction ? 'transaction' : 'identity',
    scopeRule: 'exact_lexical_scope',
    ...(transaction ? { transactionAliasSource: sourceName } : {}),
  }];
  return bindingValueAtSite(
    targetName, node, index.source, { ...source, helperChain },
  );
}

function localAliasSource(initializer: ts.Expression): {
  sourceName?: string;
  transaction: boolean;
} {
  const transaction = transactionReceiverName(initializer);
  if (transaction) return { sourceName: transaction, transaction: true };
  const unwrapped = unwrapIdentityExpression(initializer);
  return {
    sourceName: ts.isIdentifier(unwrapped) ? unwrapped.text : undefined,
    transaction: false,
  };
}

function localFactCandidate(
  node: ts.Node,
  source: ts.SourceFile,
  index: BindingLexicalIndex,
  bindings: readonly BindingSiteCandidate<LocalBindingFact>[],
): BindingSiteCandidate<LocalBindingFact> | undefined {
  if (ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name) && node.initializer) {
    const fact = directConnectFact(node.initializer);
    if (fact) return bindingValueAtSite(node.name.text, node, source, fact);
    const alias = localAliasSource(node.initializer);
    return alias.sourceName
      ? aliasLocalFact(
          alias.sourceName, node.name.text, node, index,
          bindings, alias.transaction,
        )
      : undefined;
  }
  if (!ts.isBinaryExpression(node)
    || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
  const entries = bindingAssignmentEntries(node.left);
  const fact = directConnectFact(node.right);
  return entries.length === 1 && entries[0] && !entries[0].unsupported && fact
    ? bindingValueAtSite(
        entries[0].variableName, node, source, fact,
      )
    : undefined;
}

function collectLocalBindingFacts(
  fn: ts.FunctionLikeDeclaration,
): BindingSiteCandidate<LocalBindingFact>[] {
  const source = fn.getSourceFile();
  const index = createBindingLexicalIndex(source);
  const bindings: BindingSiteCandidate<LocalBindingFact>[] = [];
  function visit(node: ts.Node): void {
    if (node !== fn && (ts.isFunctionDeclaration(node)
      || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return;
    const row = localFactCandidate(node, source, index, bindings);
    if (row) bindings.push(row);
    ts.forEachChild(node, visit);
  }
  visit(fn);
  return bindings;
}

function returnedProperty(
  property: ts.ObjectLiteralElementLike,
): { propertyName?: string; variableName?: string } {
  if (ts.isShorthandPropertyAssignment(property))
    return {
      propertyName: property.name.text,
      variableName: property.name.text,
    };
  if (!ts.isPropertyAssignment(property)
    || !ts.isIdentifier(property.initializer)) return {};
  const propertyName = ts.isIdentifier(property.name)
    || ts.isStringLiteralLike(property.name)
    ? property.name.text
    : undefined;
  return { propertyName, variableName: property.initializer.text };
}

function hazardousTryClause(
  node: ts.Node | undefined,
  fn: ts.FunctionLikeDeclaration,
  anyReturn: boolean,
): boolean {
  if (!node) return false;
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found || current !== fn && ts.isFunctionLike(current)) return;
    if (ts.isReturnStatement(current)
      && (anyReturn || current.expression !== undefined)
      || ts.isCallExpression(current) && connectFactFromCall(current)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function hasAncestor(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function unsupportedTryAncestor(
  statement: ts.TryStatement,
  returned: ts.Node,
  fn: ts.FunctionLikeDeclaration,
): boolean {
  if (!hasAncestor(returned, statement.tryBlock)) return true;
  if (hazardousTryClause(statement.catchClause?.block, fn, false))
    return true;
  return hazardousTryClause(statement.finallyBlock, fn, true);
}

function branchDependent(
  node: ts.Node,
  fn: ts.FunctionLikeDeclaration,
): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== fn) {
    if (ts.isIfStatement(current) || ts.isConditionalExpression(current)
      || ts.isSwitchStatement(current)
      || ts.isIterationStatement(current, false)) return true;
    if (ts.isTryStatement(current)
      && unsupportedTryAncestor(current, node, fn)) return true;
    current = current.parent;
  }
  return false;
}

function singleReturn(
  fn: ts.FunctionLikeDeclaration,
): ts.ReturnStatement | undefined {
  const returns: ts.ReturnStatement[] = [];
  function visit(node: ts.Node): void {
    if (node !== fn && (ts.isFunctionDeclaration(node)
      || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    else ts.forEachChild(node, visit);
  }
  visit(fn);
  const returned = returns.length === 1 ? returns[0] : undefined;
  return returned && !branchDependent(returned, fn) ? returned : undefined;
}

export function collectReturnedObjectBindings(
  fn: ts.FunctionLikeDeclaration,
): Map<string, LocalBindingFact> {
  const index = createBindingLexicalIndex(fn.getSourceFile());
  const bindings = collectLocalBindingFacts(fn);
  const out = new Map<string, LocalBindingFact>();
  const returned = singleReturn(fn)?.expression;
  if (!returned || !ts.isObjectLiteralExpression(returned)) return out;
  for (const property of returned.properties) {
    const names = returnedProperty(property);
    if (!names.propertyName || !names.variableName) continue;
    const selected = selectVisibleBinding(
      index, bindings, names.variableName, property,
    );
    const fact = deterministicLocalSource(selected);
    if (fact) out.set(names.propertyName, fact);
  }
  return out;
}

export function functionLikeInitializer(
  expression: ts.Expression | undefined,
): ts.FunctionLikeDeclaration | undefined {
  return expression && (ts.isArrowFunction(expression)
    || ts.isFunctionExpression(expression))
    ? expression
    : undefined;
}

function directReturnConnectFact(
  fn: ts.FunctionLikeDeclaration,
): LocalBindingFact | undefined {
  const index = createBindingLexicalIndex(fn.getSourceFile());
  const bindings = collectLocalBindingFacts(fn);
  const returned = singleReturn(fn)?.expression;
  if (!returned) return undefined;
  if (ts.isIdentifier(returned)) {
    const selected = selectVisibleBinding(
      index, bindings, returned.text, returned,
    );
    return selected.declarationSite?.declarationKind !== 'var'
      && (selected.site?.deterministic
        || safeTryConnectAssignment(index, selected, returned, fn))
      ? selected.candidate?.value
      : undefined;
  }
  return directConnectFact(returned);
}

function safeTryConnectAssignment(
  index: BindingLexicalIndex,
  selected: VisibleBinding<LocalBindingFact>,
  returned: ts.Identifier,
  fn: ts.FunctionLikeDeclaration,
): boolean {
  const site = selected.site;
  const declaration = selected.declarationSite;
  if (!site || !declaration || site.flow !== 'assignment'
    || !ts.isBinaryExpression(site.node)) return false;
  const writes = index.sites.filter((candidate) =>
    candidate.flow === 'assignment'
    && candidate.declarationKey === declaration.declarationKey
    && candidate.startOffset < returned.getStart(index.source));
  if (writes.length !== 1) return false;
  let current: ts.Node | undefined = site.node.parent;
  while (current && current !== fn && !ts.isTryStatement(current))
    current = current.parent;
  if (!current || !ts.isTryStatement(current)
    || !hasAncestor(site.node, current.tryBlock)) return false;
  const caught = current.catchClause?.block;
  if (caught) {
    const finalStatement = caught.statements.at(-1);
    if (!finalStatement || !ts.isThrowStatement(finalStatement)
      || hazardousTryClause(caught, fn, false)) return false;
  }
  return !hazardousTryClause(current.finallyBlock, fn, true);
}

function hasTryAncestor(
  returned: ts.ReturnStatement,
  fn: ts.FunctionLikeDeclaration,
): boolean {
  let current: ts.Node | undefined = returned.parent;
  while (current && current !== fn) {
    if (ts.isTryStatement(current)) return true;
    current = current.parent;
  }
  return false;
}

export function directConnectFactFromFunctionLike(
  fn: ts.FunctionLikeDeclaration,
): LocalBindingFact | undefined {
  if (ts.isArrowFunction(fn) && fn.body && !ts.isBlock(fn.body))
    return directConnectFact(fn.body);
  const returned = singleReturn(fn);
  const fact = directReturnConnectFact(fn);
  if (!fact || !returned || !hasTryAncestor(returned, fn)) return fact;
  return {
    ...fact,
    helperChain: [...(fact.helperChain ?? []), {
      bindingOrigin: 'single_hop_helper_return',
    }],
  };
}
