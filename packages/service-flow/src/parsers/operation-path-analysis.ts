import ts from 'typescript';
import {
  classifyODataPathIntent,
  normalizeODataOperationInvocationPath,
} from '../linker/odata-path-normalizer.js';

export type OperationPathStatus = 'static' | 'ambiguous' | 'dynamic' | 'unknown';

export interface OperationPathAnalysis {
  status: OperationPathStatus;
  rawExpression?: string;
  normalizedOperationPath?: string;
  candidateRawPaths: string[];
  candidateNormalizedOperationPaths: string[];
  placeholderKeys: string[];
  sourceKind: string;
  candidateIdentifier?: string;
  runtimeIdentifier?: string;
  dynamicReassignments: Array<{ expression: string; sourceLine: number }>;
  lexicalScope: {
    declarationLine?: number;
    assignmentLines: number[];
    sourceOrderSafe: boolean;
  };
}

interface CandidateState {
  paths: string[];
  placeholders: string[];
  dynamic: Array<{ expression: string; sourceLine: number }>;
  sourceKinds: string[];
}

interface Binding {
  declaration: ts.VariableDeclaration | ts.ParameterDeclaration;
  immutable: boolean;
}

const maxAliasDepth = 6;

export function analyzeOperationPath(
  expression: ts.Expression | undefined,
  use: ts.Node,
  method = 'POST',
): OperationPathAnalysis {
  if (!expression) return emptyAnalysis();
  const state = collectExpressionState(expression, use, 0, new Set());
  const paths = unique(state.paths.map(normalizeRawPath));
  const normalized = unique(paths.flatMap((value) => normalizedCandidate(value, method)));
  const status = pathStatus(paths, state.placeholders, state.dynamic);
  const runtimeIdentifier = state.dynamic.at(-1)?.expression;
  return {
    status,
    rawExpression: expression.getText(expression.getSourceFile()),
    normalizedOperationPath: status === 'static' && normalized.length === 1 ? normalized[0] : undefined,
    candidateRawPaths: paths,
    candidateNormalizedOperationPaths: normalized,
    placeholderKeys: unique([...state.placeholders, ...(runtimeIdentifier ? [runtimeIdentifier] : [])]),
    sourceKind: unique(state.sourceKinds).join('+') || 'unknown',
    candidateIdentifier: ts.isIdentifier(expression) ? expression.text : undefined,
    runtimeIdentifier,
    dynamicReassignments: state.dynamic,
    lexicalScope: lexicalEvidence(expression, use),
  };
}

export function operationPathExpression(analysis: OperationPathAnalysis): string | undefined {
  if (analysis.status === 'ambiguous' || analysis.status === 'unknown') return undefined;
  if (analysis.sourceKind.includes('parameter_binding')) return undefined;
  if (analysis.candidateRawPaths.length === 1 && analysis.dynamicReassignments.length === 0)
    return analysis.candidateRawPaths[0];
  if (!analysis.runtimeIdentifier || analysis.sourceKind.includes('binding_not_found'))
    return undefined;
  return isRuntimeIdentifier(analysis.runtimeIdentifier)
    ? `\${${analysis.runtimeIdentifier}}`
    : undefined;
}

export function pathUnresolvedReason(analysis: OperationPathAnalysis): string | undefined {
  if (analysis.status === 'ambiguous') return 'ambiguous_operation_path_candidates';
  if (analysis.status === 'dynamic' && !operationPathExpression(analysis))
    return 'dynamic_operation_path_identifier';
  if (analysis.dynamicReassignments.length > 0) return 'dynamic_operation_path_identifier';
  return undefined;
}

function collectExpressionState(
  expression: ts.Expression,
  use: ts.Node,
  depth: number,
  seen: Set<ts.Node>,
): CandidateState {
  const unwrapped = unwrap(expression);
  if (ts.isStringLiteral(unwrapped)) return staticState(unwrapped.text, 'string_literal');
  if (ts.isNoSubstitutionTemplateLiteral(unwrapped))
    return staticState(unwrapped.text, 'no_substitution_template');
  if (ts.isTemplateExpression(unwrapped)) return templateState(unwrapped);
  if (ts.isConditionalExpression(unwrapped))
    return mergeStates([
      collectExpressionState(unwrapped.whenTrue, use, depth + 1, seen),
      collectExpressionState(unwrapped.whenFalse, use, depth + 1, seen),
    ], 'conditional_candidates');
  if (ts.isIdentifier(unwrapped))
    return collectIdentifierState(unwrapped, use, depth, seen);
  return dynamicState(unwrapped);
}

function collectIdentifierState(
  identifier: ts.Identifier,
  use: ts.Node,
  depth: number,
  seen: Set<ts.Node>,
): CandidateState {
  if (depth >= maxAliasDepth)
    return dynamicState(identifier, 'alias_depth_exceeded');
  const binding = resolveBinding(identifier, use);
  if (!binding || seen.has(binding.declaration))
    return dynamicState(identifier, binding ? 'alias_cycle' : 'binding_not_found');
  seen.add(binding.declaration);
  if (ts.isParameter(binding.declaration))
    return dynamicState(identifier, 'parameter_binding');
  const expressions = reachingExpressions(binding.declaration, use);
  if (expressions.length === 0) return dynamicState(identifier, 'initializer_missing');
  const states = expressions.map((item) =>
    collectExpressionState(item.expression, item.node, depth + 1, seen));
  const merged = mergeStates(states, binding.immutable ? 'const_alias' : 'mutable_alias');
  if (merged.dynamic.length === 0) return merged;
  return {
    ...merged,
    dynamic: merged.dynamic.map((item) =>
      item.expression === identifier.text ? item : item),
  };
}

function reachingExpressions(
  declaration: ts.VariableDeclaration,
  use: ts.Node,
): Array<{ expression: ts.Expression; node: ts.Node }> {
  const rows: Array<{ expression: ts.Expression; node: ts.Node }> = [];
  if (declaration.initializer) rows.push({ expression: declaration.initializer, node: declaration });
  if ((declaration.parent.flags & ts.NodeFlags.Const) !== 0) return rows;
  const source = use.getSourceFile();
  const visit = (node: ts.Node): void => {
    if (node.getStart(source) >= use.getStart(source)) return;
    if (node !== source && ts.isFunctionLike(node) && !contains(node, use)) return;
    if (isAssignmentTo(node, declaration, use))
      rows.push({ expression: node.right, node });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return rows.sort((left, right) =>
    left.node.getStart(source) - right.node.getStart(source));
}

function isAssignmentTo(
  node: ts.Node,
  declaration: ts.VariableDeclaration,
  use: ts.Node,
): node is ts.BinaryExpression {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
    return false;
  if (!ts.isIdentifier(node.left) || !ts.isIdentifier(declaration.name)) return false;
  return resolveBinding(node.left, node)?.declaration === declaration && contains(declarationScope(declaration), use);
}

function resolveBinding(identifier: ts.Identifier, use: ts.Node): Binding | undefined {
  const source = use.getSourceFile();
  const matches: Array<ts.VariableDeclaration | ts.ParameterDeclaration> = [];
  const visit = (node: ts.Node): void => {
    if (isNamedDeclaration(node, identifier.text) && isAccessible(node, use))
      matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const declaration = matches.sort((left, right) =>
    right.getStart(source) - left.getStart(source))[0];
  if (!declaration) return undefined;
  const immutable = ts.isVariableDeclaration(declaration)
    && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
  return { declaration, immutable };
}

function isNamedDeclaration(
  node: ts.Node,
  name: string,
): node is ts.VariableDeclaration | ts.ParameterDeclaration {
  return (ts.isVariableDeclaration(node) || ts.isParameter(node))
    && ts.isIdentifier(node.name)
    && node.name.text === name;
}

function isAccessible(
  declaration: ts.VariableDeclaration | ts.ParameterDeclaration,
  use: ts.Node,
): boolean {
  const source = use.getSourceFile();
  if (declaration.name.getStart(source) >= use.getStart(source)) return false;
  const scope = declarationScope(declaration);
  return ts.isSourceFile(scope) || contains(scope, use);
}

function declarationScope(
  declaration: ts.VariableDeclaration | ts.ParameterDeclaration,
): ts.Node {
  if (ts.isParameter(declaration)) return declaration.parent;
  if (ts.isCatchClause(declaration.parent)) return declaration.parent.block;
  const list = declaration.parent;
  if (isLoopInitializer(list.parent)) return list.parent.statement;
  const blockScoped = (list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) !== 0;
  let current: ts.Node = list.parent;
  if (!blockScoped) {
    while (current.parent && !ts.isFunctionLike(current) && !ts.isSourceFile(current))
      current = current.parent;
    return current;
  }
  while (current.parent && !isLexicalScope(current)) current = current.parent;
  return current;
}

function isLoopInitializer(
  node: ts.Node,
): node is ts.ForStatement | ts.ForInStatement | ts.ForOfStatement {
  return ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node);
}

function isLexicalScope(node: ts.Node): boolean {
  return ts.isBlock(node)
    || ts.isSourceFile(node)
    || ts.isModuleBlock(node)
    || ts.isCaseBlock(node)
    || ts.isFunctionLike(node);
}

function templateState(expression: ts.TemplateExpression): CandidateState {
  const value = expression.getText(expression.getSourceFile()).slice(1, -1);
  return {
    paths: [value],
    placeholders: expression.templateSpans.map((span) =>
      span.expression.getText(expression.getSourceFile())),
    dynamic: [],
    sourceKinds: ['template_with_placeholders'],
  };
}

function staticState(path: string, sourceKind: string): CandidateState {
  return { paths: [path], placeholders: [], dynamic: [], sourceKinds: [sourceKind] };
}

function dynamicState(expression: ts.Expression, sourceKind = 'dynamic_expression'): CandidateState {
  return {
    paths: [],
    placeholders: [],
    dynamic: [{
      expression: expression.getText(expression.getSourceFile()),
      sourceLine: sourceLine(expression),
    }],
    sourceKinds: [sourceKind],
  };
}

function mergeStates(states: CandidateState[], sourceKind: string): CandidateState {
  return {
    paths: states.flatMap((state) => state.paths),
    placeholders: states.flatMap((state) => state.placeholders),
    dynamic: states.flatMap((state) => state.dynamic),
    sourceKinds: [sourceKind, ...states.flatMap((state) => state.sourceKinds)],
  };
}

function pathStatus(
  paths: string[],
  placeholders: string[],
  dynamic: CandidateState['dynamic'],
): OperationPathStatus {
  if (dynamic.length > 0) return 'dynamic';
  if (paths.length > 1) return 'ambiguous';
  if (placeholders.length > 0) return 'dynamic';
  if (paths.length === 1) return 'static';
  return 'unknown';
}

function normalizedCandidate(value: string, method: string): string[] {
  const invocation = normalizeODataOperationInvocationPath(value);
  if (invocation?.wasInvocation) return [invocation.normalizedOperationPath];
  const intent = classifyODataPathIntent(value, method);
  if (intent.kind.startsWith('entity_')) return [];
  if (!value.startsWith('/') || value.slice(1).includes('/') || value.includes('?')) return [];
  return [value];
}

function lexicalEvidence(expression: ts.Expression, use: ts.Node): OperationPathAnalysis['lexicalScope'] {
  if (!ts.isIdentifier(expression))
    return { assignmentLines: [], sourceOrderSafe: expression.getStart() < use.getStart() };
  const binding = resolveBinding(expression, use);
  if (!binding) return { assignmentLines: [], sourceOrderSafe: false };
  const assignmentLines = ts.isVariableDeclaration(binding.declaration)
    ? reachingExpressions(binding.declaration, use)
        .slice(binding.declaration.initializer ? 1 : 0)
        .map((item) => sourceLine(item.node))
    : [];
  return {
    declarationLine: sourceLine(binding.declaration),
    assignmentLines,
    sourceOrderSafe: true,
  };
}

function unwrap(expression: ts.Expression): ts.Expression {
  if (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression))
    return unwrap(expression.expression);
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)
    || ts.isTypeAssertionExpression(expression))
    return unwrap(expression.expression);
  return expression;
}

function normalizeRawPath(value: string): string {
  return value.startsWith('/') ? value : `/${value}`;
}

function isRuntimeIdentifier(value: string): boolean {
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value);
}

function contains(parent: ts.Node, child: ts.Node): boolean {
  const source = child.getSourceFile();
  return child.getStart(source) >= parent.getStart(source)
    && child.getEnd() <= parent.getEnd();
}

function sourceLine(node: ts.Node): number {
  const source = node.getSourceFile();
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function emptyAnalysis(): OperationPathAnalysis {
  return {
    status: 'unknown',
    candidateRawPaths: [],
    candidateNormalizedOperationPaths: [],
    placeholderKeys: [],
    sourceKind: 'missing',
    dynamicReassignments: [],
    lexicalScope: { assignmentLines: [], sourceOrderSafe: false },
  };
}
