import ts from 'typescript';
import type { LexicalScopeFact } from '../types.js';
import {
  bindingAssignmentEntries,
  type BindingAssignmentEntry,
} from './binding-assignment-targets.js';

export type BindingDeclarationKind =
  | 'const'
  | 'let'
  | 'var'
  | 'parameter'
  | 'catch'
  | 'value_shadow';

export interface BindingLexicalSite {
  variableName: string;
  node: ts.Node;
  startOffset: number;
  endOffset: number;
  flow: 'declaration' | 'assignment' | 'shadow';
  declarationKind?: BindingDeclarationKind;
  aliasSource?: string;
  aliasKind?: 'identity'
    | 'identity-assignment'
    | 'transaction'
    | 'array-destructuring';
  aliasArrayIndex?: number;
  aliasPromiseAll?: boolean;
  deterministic: boolean;
  scopeChain: LexicalScopeFact[];
  executionScope: LexicalScopeFact;
  caseClauseStartOffset?: number;
  caseClauseEndOffset?: number;
  declarationKey?: string;
}

export interface BindingSiteCandidate<T> {
  variableName: string;
  bindingSiteStartOffset?: number;
  bindingSiteEndOffset?: number;
  value: T;
}

export interface BindingLexicalIndex {
  source: ts.SourceFile;
  sites: BindingLexicalSite[];
}

export interface VisibleBinding<T> {
  status: 'resolved' | 'ambiguous' | 'unresolved';
  reason?: 'binding_not_found'
    | 'binding_declared_after_call'
    | 'unsupported_reaching_assignment'
    | 'unsupported_var_binding'
    | 'binding_flow_unsupported';
  candidate?: BindingSiteCandidate<T>;
  site?: BindingLexicalSite;
  declarationSite?: BindingLexicalSite;
  scopeIndex?: number;
}

const lexicalIndexes = new WeakMap<ts.SourceFile, BindingLexicalIndex>();

function unwrapIdentity(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)
    || ts.isAwaitExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isTypeAssertionExpression(expression))
    return unwrapIdentity(expression.expression);
  return expression;
}

function transactionSource(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  const unwrapped = unwrapIdentity(expression);
  if (ts.isConditionalExpression(unwrapped)) {
    const left = transactionSource(unwrapped.whenTrue);
    const right = transactionSource(unwrapped.whenFalse);
    return left && left === right ? left : undefined;
  }
  if (!ts.isCallExpression(unwrapped)
    || !ts.isPropertyAccessExpression(unwrapped.expression)) return undefined;
  const receiver = unwrapped.expression;
  return ['tx', 'transaction'].includes(receiver.name.text)
    && ts.isIdentifier(receiver.expression)
    ? receiver.expression.text
    : undefined;
}

function directAlias(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  const unwrapped = unwrapIdentity(expression);
  return ts.isIdentifier(unwrapped)
    ? unwrapped.text
    : transactionSource(unwrapped);
}

function scopeKind(node: ts.Node): LexicalScopeFact['kind'] | undefined {
  if (ts.isSourceFile(node)) return 'source_file';
  if (ts.isModuleBlock(node)) return 'module_block';
  if (ts.isFunctionLike(node)) return 'function';
  if (ts.isClassLike(node)) return 'class';
  if (ts.isIterationStatement(node, false)) return 'loop';
  if (ts.isCaseBlock(node)) return 'case_block';
  if (ts.isBlock(node)) return 'block';
  return ts.isCatchClause(node) ? 'catch' : undefined;
}

function lexicalScope(node: ts.Node, source: ts.SourceFile): LexicalScopeFact | undefined {
  const kind = scopeKind(node);
  if (!kind) return undefined;
  return {
    kind,
    startOffset: ts.isSourceFile(node) ? 0 : node.getStart(source),
    endOffset: node.getEnd(),
  };
}

export function lexicalScopeChain(
  node: ts.Node,
  source: ts.SourceFile,
): LexicalScopeFact[] {
  const scopes: LexicalScopeFact[] = [];
  let current: ts.Node | undefined = node;
  while (current) {
    const scope = lexicalScope(current, source);
    if (scope) scopes.push(scope);
    current = current.parent;
  }
  return scopes.reverse();
}

export function sameScope(
  left: LexicalScopeFact,
  right: LexicalScopeFact,
): boolean {
  return left.kind === right.kind
    && left.startOffset === right.startOffset
    && left.endOffset === right.endOffset;
}

export function executionScope(
  chain: readonly LexicalScopeFact[],
): LexicalScopeFact {
  return [...chain].reverse().find((scope) =>
    scope.kind === 'function' || scope.kind === 'source_file')
    ?? { kind: 'source_file', startOffset: 0, endOffset: 0 };
}

function declarationKind(node: ts.VariableDeclaration): BindingDeclarationKind {
  const flags = node.parent.flags;
  if ((flags & ts.NodeFlags.Const) !== 0) return 'const';
  return (flags & ts.NodeFlags.Let) !== 0 ? 'let' : 'var';
}

const shortCircuitOperators = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function shortCircuitRightBranch(
  descendant: ts.Node,
  node: ts.Node,
): boolean {
  return ts.isBinaryExpression(node)
    && shortCircuitOperators.has(node.operatorToken.kind)
    && descendant.pos >= node.right.pos
    && descendant.end <= node.right.end;
}

function optionalChainAncestor(node: ts.Node): boolean {
  return (ts.isCallExpression(node)
      || ts.isPropertyAccessExpression(node)
      || ts.isElementAccessExpression(node))
    && Boolean(node.questionDotToken);
}

function deferredClassInitializer(node: ts.Node): boolean {
  return ts.isPropertyDeclaration(node)
    && (ts.getCombinedModifierFlags(node)
      & ts.ModifierFlags.Static) === 0;
}

function controlFlowAncestor(node: ts.Node): boolean {
  return ts.isIfStatement(node)
    || ts.isConditionalExpression(node)
    || ts.isSwitchStatement(node)
    || ts.isIterationStatement(node, false)
    || ts.isTryStatement(node)
    || deferredClassInitializer(node);
}

function branchDependent(node: ts.Node): boolean {
  let descendant = node;
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current) && !ts.isFunctionLike(current)) {
    if (controlFlowAncestor(current)
      || shortCircuitRightBranch(descendant, current)
      || optionalChainAncestor(current)) return true;
    descendant = current;
    current = current.parent;
  }
  return false;
}

function bindingEntries(name: ts.BindingName): Array<{
  variableName: string;
  element?: ts.BindingElement;
  arrayIndex?: number;
}> {
  if (ts.isIdentifier(name)) return [{ variableName: name.text }];
  return name.elements.flatMap((element, arrayIndex) =>
    ts.isBindingElement(element)
      ? bindingEntries(element.name).map((entry) => ({
          ...entry,
          element,
          ...(ts.isArrayBindingPattern(name) ? { arrayIndex } : {}),
        }))
      : []);
}

function arrayContainer(
  expression: ts.Expression | undefined,
): { array: ts.ArrayLiteralExpression; promiseAll: boolean } | undefined {
  if (!expression) return undefined;
  const unwrapped = unwrapIdentity(expression);
  if (ts.isArrayLiteralExpression(unwrapped))
    return { array: unwrapped, promiseAll: false };
  if (!ts.isCallExpression(unwrapped)
    || !ts.isPropertyAccessExpression(unwrapped.expression)
    || unwrapped.expression.name.text !== 'all'
    || unwrapped.expression.expression.getText() !== 'Promise') return undefined;
  const first = unwrapped.arguments[0];
  if (!first) return undefined;
  const container = unwrapIdentity(first);
  return ts.isArrayLiteralExpression(container)
    ? { array: container, promiseAll: true }
    : undefined;
}

function entryAlias(
  node: ts.VariableDeclaration,
  entry: {
    variableName: string;
    element?: ts.BindingElement;
    arrayIndex?: number;
  },
): string | undefined {
  if (!entry.element) return directAlias(node.initializer);
  if (!ts.isArrayBindingPattern(node.name)) return undefined;
  const expression = entry.arrayIndex === undefined
    ? undefined
    : arrayContainer(node.initializer)?.array.elements[entry.arrayIndex];
  return expression && !ts.isOmittedExpression(expression)
    ? directAlias(expression)
    : undefined;
}

function siteBase(
  source: ts.SourceFile,
  node: ts.Node,
): Pick<BindingLexicalSite, 'node' | 'startOffset' | 'endOffset'
  | 'scopeChain' | 'executionScope'
  | 'caseClauseStartOffset' | 'caseClauseEndOffset'> {
  const scopeChain = lexicalScopeChain(node, source);
  const clause = enclosingCaseClause(node);
  return {
    node,
    startOffset: node.getStart(source),
    endOffset: node.getEnd(),
    scopeChain,
    executionScope: executionScope(scopeChain),
    caseClauseStartOffset: clause?.getStart(source),
    caseClauseEndOffset: clause?.getEnd(),
  };
}

export function enclosingCaseClause(
  node: ts.Node,
): ts.CaseClause | ts.DefaultClause | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)
    && !ts.isFunctionLike(current)) {
    if (ts.isCaseClause(current) || ts.isDefaultClause(current))
      return current;
    current = current.parent;
  }
  return undefined;
}

function hoistedVarSiteBase(
  source: ts.SourceFile,
  node: ts.Node,
): ReturnType<typeof siteBase> {
  const full = lexicalScopeChain(node, source);
  const scope = executionScope(full);
  const scopeIndex = full.findIndex((item) => sameScope(item, scope));
  return {
    node,
    startOffset: node.getStart(source),
    endOffset: node.getEnd(),
    scopeChain: full.slice(0, scopeIndex + 1),
    executionScope: scope,
    caseClauseStartOffset: undefined,
    caseClauseEndOffset: undefined,
  };
}

function declarationSites(
  source: ts.SourceFile,
  node: ts.VariableDeclaration,
): BindingLexicalSite[] {
  const kind = declarationKind(node);
  const base = kind === 'var'
    ? hoistedVarSiteBase(source, node)
    : siteBase(source, node);
  return bindingEntries(node.name).map((entry) => {
    const aliasSource = entryAlias(node, entry);
    const transaction = !entry.element
      && transactionSource(node.initializer) === aliasSource;
    return {
      ...base,
      variableName: entry.variableName,
      flow: 'declaration',
      declarationKind: kind,
      aliasSource,
      aliasKind: aliasSource
        ? entry.arrayIndex === undefined
          ? transaction ? 'transaction' : 'identity'
          : 'array-destructuring'
        : undefined,
      aliasArrayIndex: entry.arrayIndex,
      aliasPromiseAll: entry.arrayIndex === undefined
        ? undefined
        : arrayContainer(node.initializer)?.promiseAll,
      deterministic: declarationKind(node) !== 'var',
    };
  });
}

function assignmentAlias(
  node: ts.BinaryExpression,
  entry: BindingAssignmentEntry,
): string | undefined {
  if (entry.unsupported) return undefined;
  if (entry.arrayIndex === undefined) return directAlias(node.right);
  const expression = arrayContainer(node.right)?.array.elements[entry.arrayIndex];
  return expression && !ts.isOmittedExpression(expression)
    ? directAlias(expression)
    : undefined;
}

function assignmentSites(
  source: ts.SourceFile,
  node: ts.BinaryExpression,
): BindingLexicalSite[] {
  const base = siteBase(source, node);
  return bindingAssignmentEntries(node.left).map((entry) => {
    const aliasSource = assignmentAlias(node, entry);
    const transaction = entry.arrayIndex === undefined
      && transactionSource(node.right) === aliasSource;
    return {
      ...base,
      variableName: entry.variableName,
      flow: 'assignment',
      aliasSource,
      aliasKind: aliasSource
        ? entry.arrayIndex === undefined
          ? transaction ? 'transaction' : 'identity-assignment'
          : 'array-destructuring'
        : undefined,
      aliasArrayIndex: entry.arrayIndex,
      aliasPromiseAll: entry.arrayIndex === undefined
        ? undefined
        : arrayContainer(node.right)?.promiseAll,
      deterministic: !entry.unsupported
        && !shortCircuitOperators.has(node.operatorToken.kind)
        && !branchDependent(node),
    };
  });
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment
    && kind <= ts.SyntaxKind.LastAssignment;
}

function isMutationUnary(
  node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
): boolean {
  return node.operator === ts.SyntaxKind.PlusPlusToken
    || node.operator === ts.SyntaxKind.MinusMinusToken;
}

function parameterSites(
  source: ts.SourceFile,
  node: ts.ParameterDeclaration,
): BindingLexicalSite[] {
  const base = siteBase(source, node.parent);
  return bindingEntries(node.name).map(({ variableName }) => ({
    ...base,
    node,
    startOffset: node.getStart(source),
    endOffset: node.getEnd(),
    variableName,
    flow: 'declaration',
    declarationKind: 'parameter',
    deterministic: true,
  }));
}

function shadowSite(
  source: ts.SourceFile,
  name: ts.Identifier,
  scopeNode: ts.Node,
): BindingLexicalSite {
  const base = siteBase(source, scopeNode);
  return {
    ...base,
    node: name,
    startOffset: name.getStart(source),
    endOffset: name.getEnd(),
    variableName: name.text,
    flow: 'shadow',
    declarationKind: 'value_shadow',
    deterministic: false,
  };
}

function declarationShadowName(node: ts.Node): ts.Identifier | undefined {
  if (ts.isFunctionDeclaration(node)) return node.name;
  if (ts.isClassDeclaration(node)) return node.name;
  return ts.isEnumDeclaration(node) ? node.name : undefined;
}

function expressionShadowName(node: ts.Node): ts.Identifier | undefined {
  if (ts.isFunctionExpression(node)) return node.name;
  return ts.isClassExpression(node) ? node.name : undefined;
}

function valueShadowSites(
  source: ts.SourceFile,
  node: ts.Node,
): BindingLexicalSite[] {
  const declaration = declarationShadowName(node);
  if (declaration)
    return [shadowSite(source, declaration, node.parent)];
  if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name))
    return [shadowSite(source, node.name, node.parent)];
  if (ts.isImportEqualsDeclaration(node))
    return [shadowSite(source, node.name, node.parent)];
  const expression = expressionShadowName(node);
  if (expression) return [shadowSite(source, expression, node)];
  return [];
}

function mutationSite(
  source: ts.SourceFile,
  expression: ts.Expression,
): BindingLexicalSite[] {
  if (!ts.isIdentifier(expression)) return [];
  return [{
    ...siteBase(source, expression),
    variableName: expression.text,
    flow: 'assignment',
    deterministic: false,
  }];
}

function loopWriteSites(
  source: ts.SourceFile,
  node: ts.ForInOrOfStatement,
): BindingLexicalSite[] {
  return ts.isVariableDeclarationList(node.initializer)
    ? []
    : bindingAssignmentEntries(node.initializer).map((entry) => ({
        ...siteBase(source, node.initializer),
        variableName: entry.variableName,
        flow: 'assignment',
        deterministic: false,
      }));
}

function collectSites(source: ts.SourceFile): BindingLexicalSite[] {
  const sites: BindingLexicalSite[] = [];
  const visit = (node: ts.Node): void => {
    sites.push(...valueShadowSites(source, node));
    if (ts.isVariableDeclaration(node))
      sites.push(...declarationSites(source, node));
    if (ts.isParameter(node))
      sites.push(...parameterSites(source, node));
    if (ts.isBinaryExpression(node)
      && isAssignmentOperator(node.operatorToken.kind))
      sites.push(...assignmentSites(source, node));
    if (ts.isForInStatement(node) || ts.isForOfStatement(node))
      sites.push(...loopWriteSites(source, node));
    if ((ts.isPrefixUnaryExpression(node)
      || ts.isPostfixUnaryExpression(node)) && isMutationUnary(node))
      sites.push(...mutationSite(source, node.operand));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites.sort((left, right) =>
    left.startOffset - right.startOffset || left.endOffset - right.endOffset);
}

function declarationKey(site: BindingLexicalSite): string {
  return [
    site.variableName,
    site.startOffset,
    site.endOffset,
    site.declarationKind,
  ].join('\u0000');
}

export function declarationAt(
  sites: readonly BindingLexicalSite[],
  variableName: string,
  useStart: number,
  useChain: readonly LexicalScopeFact[],
): { site?: BindingLexicalSite; scopeIndex?: number; after: boolean; ambiguous: boolean } {
  const declarations = sites.flatMap((site) => {
    if (!['declaration', 'shadow'].includes(site.flow)
      || site.variableName !== variableName) return [];
    const scope = site.scopeChain.at(-1);
    const scopeIndex = scope
      ? useChain.findIndex((candidate) => sameScope(candidate, scope))
      : -1;
    return scopeIndex >= 0 ? [{ site, scopeIndex }] : [];
  });
  const deepest = Math.max(-1, ...declarations.map((item) => item.scopeIndex));
  const nearest = declarations.filter((item) => item.scopeIndex === deepest);
  if (nearest.length === 0) return { after: false, ambiguous: false };
  if (nearest.length > 1)
    return { after: false, ambiguous: true, scopeIndex: deepest };
  const site = nearest[0]?.site;
  return {
    site,
    scopeIndex: deepest,
    after: Boolean(site && site.declarationKind !== 'var'
      && site.startOffset >= useStart),
    ambiguous: false,
  };
}

function attachDeclarationKeys(sites: BindingLexicalSite[]): void {
  for (const site of sites) {
    if (site.flow === 'declaration' || site.flow === 'shadow') {
      site.declarationKey = declarationKey(site);
      continue;
    }
    const selected = declarationAt(
      sites, site.variableName, site.startOffset, site.scopeChain,
    );
    if (selected.site && !selected.after && !selected.ambiguous)
      site.declarationKey = declarationKey(selected.site);
  }
}

export function createBindingLexicalIndex(
  source: ts.SourceFile,
): BindingLexicalIndex {
  const cached = lexicalIndexes.get(source);
  if (cached) return cached;
  const sites = collectSites(source);
  attachDeclarationKeys(sites);
  const index = { source, sites };
  lexicalIndexes.set(source, index);
  return index;
}

export function bindingSite(
  index: BindingLexicalIndex,
  variableName: string,
  startOffset: number,
  endOffset: number,
): BindingLexicalSite | undefined {
  const matches = index.sites.filter((site) =>
    site.variableName === variableName
    && site.startOffset === startOffset
    && site.endOffset === endOffset);
  return matches.length === 1 ? matches[0] : undefined;
}
