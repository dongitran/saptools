import ts from 'typescript';
import type { LexicalScopeFact } from '../types.js';
import {
  declarationAt,
  enclosingCaseClause,
  executionScope,
  lexicalScopeChain,
  sameScope,
  type BindingLexicalIndex,
  type BindingLexicalSite,
  type BindingSiteCandidate,
  type VisibleBinding,
} from './011-binding-lexical-scope.js';

function reachingSites(
  index: BindingLexicalIndex,
  variableName: string,
  useStart: number,
  useChain: readonly LexicalScopeFact[],
  declaration: BindingLexicalSite,
): BindingLexicalSite[] {
  const useExecution = executionScope(useChain);
  return index.sites.filter((site) =>
    site.variableName === variableName
    && site.declarationKey === declaration.declarationKey
    && site.startOffset < useStart
    && (site.flow === 'declaration'
      || sameScope(site.executionScope, useExecution)))
    .sort((left, right) =>
      right.startOffset - left.startOffset
      || right.endOffset - left.endOffset);
}

function enclosingLoops(node: ts.Node): ts.IterationStatement[] {
  const loops: ts.IterationStatement[] = [];
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)
    && !ts.isFunctionLike(current)) {
    if (ts.isIterationStatement(current, false)) loops.push(current);
    current = current.parent;
  }
  return loops;
}

function unsupportedAssignmentFlow(
  index: BindingLexicalIndex,
  variableName: string,
  useNode: ts.Node,
  useStart: number,
  useChain: readonly LexicalScopeFact[],
  declaration: BindingLexicalSite,
): boolean {
  const useExecution = executionScope(useChain);
  const loops = enclosingLoops(useNode);
  return index.sites.some((site) => {
    if (site.flow !== 'assignment'
      || site.variableName !== variableName
      || site.declarationKey !== declaration.declarationKey) return false;
    if (!sameScope(site.executionScope, useExecution)) return true;
    return site.startOffset > useStart && loops.some((loop) =>
      site.node.pos >= loop.pos && site.node.end <= loop.end);
  });
}

function candidatesAtSite<T>(
  candidates: readonly BindingSiteCandidate<T>[],
  site: BindingLexicalSite,
): BindingSiteCandidate<T>[] {
  return candidates.filter((candidate) =>
    candidate.variableName === site.variableName
    && candidate.bindingSiteStartOffset === site.startOffset
    && candidate.bindingSiteEndOffset === site.endOffset);
}

function compatibleCaseClause(
  site: BindingLexicalSite,
  useNode: ts.Node,
  source: ts.SourceFile,
): boolean {
  if (site.caseClauseStartOffset === undefined
    || site.caseClauseEndOffset === undefined) return true;
  const clause = enclosingCaseClause(useNode);
  return clause?.getStart(source) === site.caseClauseStartOffset
    && clause.getEnd() === site.caseClauseEndOffset;
}

type VisibleBindingReason = NonNullable<VisibleBinding<unknown>['reason']>;

function declarationFailure(
  declaration: BindingLexicalSite,
  after: boolean,
  useNode: ts.Node,
  source: ts.SourceFile,
): VisibleBindingReason | undefined {
  if (declaration.flow === 'shadow') return 'binding_flow_unsupported';
  if (declaration.declarationKind === 'var') return 'unsupported_var_binding';
  if (!compatibleCaseClause(declaration, useNode, source))
    return 'binding_flow_unsupported';
  return after ? 'binding_declared_after_call' : undefined;
}

function matchedBinding<T>(
  candidates: readonly BindingSiteCandidate<T>[],
  site: BindingLexicalSite,
): VisibleBinding<T> | undefined {
  const matches = candidatesAtSite(candidates, site);
  if (matches.length === 0) return {
    status: 'unresolved',
    reason: site.flow === 'assignment'
      ? 'unsupported_reaching_assignment'
      : 'binding_not_found',
  };
  if (matches.length > 1) return { status: 'ambiguous' };
  return matches[0] ? { status: 'resolved', candidate: matches[0] } : undefined;
}

export function selectVisibleBinding<T>(
  index: BindingLexicalIndex,
  candidates: readonly BindingSiteCandidate<T>[],
  variableName: string,
  useNode: ts.Node,
): VisibleBinding<T> {
  const useStart = useNode.getStart(index.source);
  const useChain = lexicalScopeChain(useNode, index.source);
  const declaration = declarationAt(index.sites, variableName, useStart, useChain);
  if (declaration.ambiguous) return { status: 'ambiguous' };
  if (!declaration.site) return { status: 'unresolved', reason: 'binding_not_found' };
  const failure = declarationFailure(
    declaration.site, declaration.after, useNode, index.source,
  );
  if (failure) return { status: 'unresolved', reason: failure };
  if (unsupportedAssignmentFlow(
    index, variableName, useNode, useStart, useChain, declaration.site,
  )) return {
    status: 'unresolved',
    reason: 'unsupported_reaching_assignment',
  };
  const site = reachingSites(
    index, variableName, useStart, useChain, declaration.site,
  )[0];
  if (!site) return { status: 'unresolved', reason: 'binding_not_found' };
  const matched = matchedBinding(candidates, site);
  if (!matched || matched.status !== 'resolved') return matched ?? {
    status: 'unresolved', reason: 'binding_not_found',
  };
  return {
    ...matched,
    site,
    declarationSite: declaration.site,
    scopeIndex: declaration.scopeIndex,
  };
}
