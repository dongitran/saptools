import ts from 'typescript';
import type {
  ExecutableSymbolFact,
  LexicalScopeFact,
  OutboundCallFact,
  ServiceBindingFact,
  ServiceBindingReference,
} from '../types.js';
import {
  executableSymbolCandidates,
  selectCallOwner,
} from './004-fact-identity.js';
import {
  bindingSite,
  createBindingLexicalIndex,
  lexicalScopeChain,
  type BindingLexicalIndex,
  type BindingLexicalSite,
  type VisibleBinding,
} from './011-binding-lexical-scope.js';
import { selectVisibleBinding } from './021-binding-visibility.js';

const scopeChainCap = 16;

interface PreparedBinding {
  fact: ServiceBindingFact;
  site: BindingLexicalSite;
  aliasProven: boolean;
}

function matchFactsToSites(
  index: BindingLexicalIndex,
  facts: readonly ServiceBindingFact[],
): Array<{ fact: ServiceBindingFact; site: BindingLexicalSite }> {
  return facts.map((fact) => {
    if (fact.bindingSiteStartOffset === undefined
      || fact.bindingSiteEndOffset === undefined)
      throw new Error('invalid_prepared_repository_snapshot:binding_site_missing');
    const site = bindingSite(
      index,
      fact.variableName,
      fact.bindingSiteStartOffset,
      fact.bindingSiteEndOffset,
    );
    if (!site)
      throw new Error('invalid_prepared_repository_snapshot:binding_site_invalid');
    return { fact, site };
  });
}

function exactOwner(
  fact: ServiceBindingFact,
  site: BindingLexicalSite,
  symbols: readonly ExecutableSymbolFact[],
): ServiceBindingFact {
  const candidates = executableSymbolCandidates(symbols, fact.sourceFile);
  const owner = selectCallOwner(
    candidates, site.startOffset, site.endOffset,
  );
  if (owner.status === 'ambiguous')
    throw new Error('invalid_prepared_repository_snapshot:binding_owner_ambiguous');
  return {
    ...fact,
    bindingSiteStartOffset: site.startOffset,
    bindingSiteEndOffset: site.endOffset,
    sourceSymbolQualifiedName: owner.owner?.qualifiedName,
    ownerResolution: owner.status === 'resolved'
      ? 'owned_exact'
      : 'ownerless_file_scope',
  };
}

function prepareBindings(
  index: BindingLexicalIndex,
  facts: readonly ServiceBindingFact[],
  symbols: readonly ExecutableSymbolFact[],
): PreparedBinding[] {
  return matchFactsToSites(index, facts).map(({ fact, site }) => ({
    fact: exactOwner(fact, site, symbols),
    site,
    aliasProven: site.aliasSource === undefined,
  }));
}

function aliasStep(binding: PreparedBinding, source: PreparedBinding): Record<string, unknown> {
  const aliasKind = binding.site.aliasKind
    ?? (binding.site.flow === 'assignment'
      ? 'identity-assignment'
      : 'identity');
  return {
    callerVariable: binding.fact.variableName,
    aliasOf: source.fact.variableName,
    aliasKind,
    scopeRule: 'exact_lexical_scope',
    ...(aliasKind === 'transaction'
      ? { transactionAliasSource: source.fact.variableName }
      : {}),
    ...(binding.site.aliasArrayIndex === undefined ? {} : {
      sourceVariable: source.fact.variableName,
      arrayIndex: binding.site.aliasArrayIndex,
      promiseAll: binding.site.aliasPromiseAll ?? false,
      arrayContainer: binding.site.aliasPromiseAll
        ? 'Promise.all'
        : 'array_literal',
    }),
  };
}

function copyAliasProvenance(
  binding: PreparedBinding,
  source: PreparedBinding,
): void {
  binding.fact = {
    ...binding.fact,
    alias: source.fact.alias,
    aliasExpr: source.fact.aliasExpr,
    destinationExpr: source.fact.destinationExpr,
    servicePathExpr: source.fact.servicePathExpr,
    isDynamic: source.fact.isDynamic,
    placeholders: source.fact.placeholders,
    helperChain: [
      ...(source.fact.helperChain ?? []),
      aliasStep(binding, source),
    ],
  };
  binding.aliasProven = true;
}

function bindingCandidates(
  bindings: readonly PreparedBinding[],
): Array<{
  variableName: string;
  bindingSiteStartOffset: number;
  bindingSiteEndOffset: number;
  value: PreparedBinding;
}> {
  return bindings.map((binding) => ({
    variableName: binding.fact.variableName,
    bindingSiteStartOffset: binding.site.startOffset,
    bindingSiteEndOffset: binding.site.endOffset,
    value: binding,
  }));
}

function resolvedAliasSource(
  selected: VisibleBinding<PreparedBinding>,
): PreparedBinding | undefined {
  if (selected.status !== 'resolved') return undefined;
  if (!selected.site?.deterministic) return undefined;
  if (selected.declarationSite?.declarationKind === 'var') return undefined;
  const source = selected.candidate?.value;
  return source?.aliasProven ? source : undefined;
}

function reconcileAliases(
  index: BindingLexicalIndex,
  bindings: PreparedBinding[],
): void {
  const candidates = bindingCandidates(bindings);
  for (const binding of bindings) {
    const sourceName = binding.site.aliasSource;
    if (!sourceName) continue;
    const selected = selectVisibleBinding(
      index, candidates, sourceName, binding.site.node,
    );
    const source = resolvedAliasSource(selected);
    if (source) copyAliasProvenance(binding, source);
  }
}

function assertUniqueSites(bindings: readonly PreparedBinding[]): void {
  const seen = new Set<string>();
  for (const binding of bindings) {
    const key = [
      binding.fact.sourceFile,
      binding.fact.variableName,
      binding.site.startOffset,
      binding.site.endOffset,
    ].join('\u0000');
    if (seen.has(key))
      throw new Error('invalid_prepared_repository_snapshot:duplicate_service_binding_site');
    seen.add(key);
  }
}

function callNodeMap(source: ts.SourceFile): Map<string, ts.CallExpression> {
  const calls = new Map<string, ts.CallExpression>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node))
      calls.set(`${node.getStart(source)}:${node.getEnd()}`, node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function emptyReference(
  call: OutboundCallFact,
  reason?: ServiceBindingReference['reason'],
): ServiceBindingReference {
  return {
    status: call.serviceVariableName ? 'unresolved' : 'not_applicable',
    variableName: call.serviceVariableName,
    scopeChainTotal: 0,
    scopeChainShown: 0,
    scopeChainOmitted: 0,
    reason,
  };
}

function rejectedReference(
  call: OutboundCallFact,
  chain: LexicalScopeFact[],
  reason: ServiceBindingReference['reason'],
  status: 'ambiguous' | 'unresolved' = 'unresolved',
): ServiceBindingReference {
  return {
    status,
    variableName: call.serviceVariableName,
    scopeChainTotal: chain.length,
    scopeChainShown: Math.min(chain.length, scopeChainCap),
    scopeChainOmitted: Math.max(0, chain.length - scopeChainCap),
    reason,
  };
}

function resolvedReference(
  call: OutboundCallFact,
  selected: PreparedBinding,
  chain: LexicalScopeFact[],
  scopeIndex: number,
): ServiceBindingReference {
  const helperReturn = selected.fact.helperChain?.some(
    (step) => step.bindingOrigin === 'single_hop_helper_return',
  ) ?? false;
  return {
    status: 'resolved_exact',
    variableName: call.serviceVariableName,
    bindingSourceFile: selected.fact.sourceFile,
    bindingSiteStartOffset: selected.site.startOffset,
    bindingSiteEndOffset: selected.site.endOffset,
    resolutionStrategy: selected.site.flow === 'assignment'
      ? 'deterministic_reaching_assignment'
      : selected.site.aliasSource
        ? 'lexical_alias_declaration'
        : helperReturn
          ? 'single_hop_helper_return'
          : 'lexical_declaration',
    lexicalScopeChain: chain,
    bindingScopeIndex: scopeIndex,
    scopeChainTotal: chain.length,
    scopeChainShown: chain.length,
    scopeChainOmitted: 0,
  };
}

function selectedBindingReference(
  call: OutboundCallFact,
  chain: LexicalScopeFact[],
  chosen: VisibleBinding<PreparedBinding>,
): ServiceBindingReference {
  const selected = chosen.candidate?.value;
  if (!selected) {
    return rejectedReference(
      call, chain, chosen.reason ?? 'binding_not_found',
    );
  }
  if (chosen.declarationSite?.declarationKind === 'var')
    return rejectedReference(call, chain, 'unsupported_var_binding');
  if (!selected.site.deterministic || !selected.aliasProven)
    return rejectedReference(call, chain, 'unsupported_reaching_assignment');
  return resolvedReference(call, selected, chain, chosen.scopeIndex ?? 0);
}

function bindingReference(
  call: OutboundCallFact,
  node: ts.CallExpression | undefined,
  index: BindingLexicalIndex,
  bindings: readonly PreparedBinding[],
): ServiceBindingReference {
  if (!call.serviceVariableName) return emptyReference(call);
  if (!node) return emptyReference(call, 'binding_flow_unsupported');
  const chain = lexicalScopeChain(node, index.source);
  if (chain.length > scopeChainCap)
    return rejectedReference(call, chain, 'scope_chain_limit_exceeded');
  const chosen = selectVisibleBinding(
    index, bindingCandidates(bindings), call.serviceVariableName, node,
  );
  if (chosen.status === 'ambiguous')
    return rejectedReference(
      call, chain, 'binding_scope_ambiguous', 'ambiguous',
    );
  return selectedBindingReference(call, chain, chosen);
}

function exactCallOwner(
  call: OutboundCallFact,
  symbols: readonly ExecutableSymbolFact[],
): { qualifiedName?: string; resolution: 'owned_exact' | 'ownerless_file_scope' } {
  const start = call.callSiteStartOffset;
  const end = call.callSiteEndOffset;
  if (start === undefined || end === undefined)
    return { resolution: 'ownerless_file_scope' };
  const selected = selectCallOwner(
    executableSymbolCandidates(symbols, call.sourceFile),
    start,
    end,
    call.callType === 'async_subscribe',
  );
  if (selected.status === 'ambiguous')
    throw new Error('invalid_prepared_repository_snapshot:outbound_owner_ambiguous');
  if (call.callType === 'async_subscribe' && selected.status !== 'resolved')
    throw new Error('invalid_prepared_repository_snapshot:subscription_owner_missing');
  return selected.owner
    ? { qualifiedName: selected.owner.qualifiedName, resolution: 'owned_exact' }
    : { resolution: 'ownerless_file_scope' };
}

export function reconcileBindingAndCallIdentity(
  source: ts.SourceFile,
  bindingFacts: readonly ServiceBindingFact[],
  callFacts: readonly OutboundCallFact[],
  symbols: readonly ExecutableSymbolFact[],
): { bindings: ServiceBindingFact[]; calls: OutboundCallFact[] } {
  const lexicalIndex = createBindingLexicalIndex(source);
  const bindings = prepareBindings(lexicalIndex, bindingFacts, symbols);
  reconcileAliases(lexicalIndex, bindings);
  assertUniqueSites(bindings);
  const nodes = callNodeMap(source);
  const calls = callFacts.map((call) => {
    const key = `${call.callSiteStartOffset}:${call.callSiteEndOffset}`;
    const reference = bindingReference(
      call, nodes.get(key), lexicalIndex, bindings,
    );
    const owner = exactCallOwner(call, symbols);
    return {
      ...call,
      sourceSymbolQualifiedName: owner.qualifiedName,
      serviceBindingReference: reference,
      evidence: {
        ...(call.evidence ?? {}),
        sourceOwnerResolution: owner.resolution,
        serviceBindingReference: reference,
      },
    };
  });
  return { bindings: bindings.map((binding) => binding.fact), calls };
}
