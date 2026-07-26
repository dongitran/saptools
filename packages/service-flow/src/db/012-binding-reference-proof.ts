import type {
  LexicalScopeFact,
  ServiceBindingReference,
} from '../types.js';

export interface BindingProofCall {
  repoId: number;
  bindingId: number | null;
  variableName?: string;
  sourceFile: string;
  startOffset: number;
  endOffset: number;
}

export interface BindingProofTarget {
  id: number;
  repoId: number;
  symbolId: number | null;
  variableName: string;
  sourceFile: string;
  startOffset: number;
  endOffset: number;
  ownerResolution: string;
  ownerStartOffset: number | null;
  ownerEndOffset: number | null;
  singleHopHelperReturn: boolean;
}

interface ResolvedBindingProof {
  variableName: string;
  bindingSourceFile: string;
  bindingSiteStartOffset: number;
  bindingSiteEndOffset: number;
  resolutionStrategy: NonNullable<
    ServiceBindingReference['resolutionStrategy']
  >;
  lexicalScopeChain: LexicalScopeFact[];
  bindingScopeIndex: number;
}

const scopeKinds = new Set([
  'source_file', 'module_block', 'function', 'class', 'loop',
  'case_block', 'block', 'catch',
]);
const strategies = new Set([
  'lexical_declaration',
  'lexical_alias_declaration',
  'deterministic_reaching_assignment',
  'single_hop_helper_return',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function integer(value: unknown): value is number {
  return Number.isInteger(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function all(values: readonly boolean[]): boolean {
  return values.every(Boolean);
}

export function validBindingLexicalScope(
  value: unknown,
): value is LexicalScopeFact {
  const scope = record(value);
  return Boolean(scope && scopeKinds.has(String(scope.kind))
    && integer(scope.startOffset) && integer(scope.endOffset)
    && Number(scope.startOffset) >= 0
    && Number(scope.endOffset) > Number(scope.startOffset));
}

export function bindingReferenceCountsValid(
  reference: Record<string, unknown>,
): boolean {
  const total = reference.scopeChainTotal;
  const shown = reference.scopeChainShown;
  const omitted = reference.scopeChainOmitted;
  return integer(total) && integer(shown) && integer(omitted)
    && total >= 0 && shown >= 0 && omitted >= 0 && shown <= 16
    && shown + omitted === total;
}

function scopeArray(value: unknown): LexicalScopeFact[] | undefined {
  if (!Array.isArray(value) || !value.every(validBindingLexicalScope))
    return undefined;
  return value;
}

function resolvedProofFields(
  call: BindingProofCall,
  reference: Record<string, unknown>,
): boolean {
  return all([
    reference.status === 'resolved_exact',
    nonEmpty(reference.variableName),
    call.variableName === undefined
      || reference.variableName === call.variableName,
    reference.bindingSourceFile === call.sourceFile,
    integer(reference.bindingSiteStartOffset),
    integer(reference.bindingSiteEndOffset),
    strategies.has(String(reference.resolutionStrategy)),
    reference.reason === undefined,
  ]);
}

function resolvedProof(
  call: BindingProofCall,
  value: unknown,
): ResolvedBindingProof | undefined {
  const reference = record(value);
  if (!reference || !resolvedProofFields(call, reference)) return undefined;
  const chain = scopeArray(reference.lexicalScopeChain);
  const index = reference.bindingScopeIndex;
  if (!chain || !integer(index) || !resolvedChainValid(
    reference, chain, index,
  )) return undefined;
  if (!resolvedProofValuesValid(reference)) return undefined;
  return {
    variableName: reference.variableName,
    bindingSourceFile: reference.bindingSourceFile,
    bindingSiteStartOffset: reference.bindingSiteStartOffset,
    bindingSiteEndOffset: reference.bindingSiteEndOffset,
    resolutionStrategy: reference.resolutionStrategy,
    lexicalScopeChain: chain,
    bindingScopeIndex: index,
  };
}

function resolvedProofValuesValid(
  value: Record<string, unknown>,
): value is Record<string, unknown> & {
  variableName: string;
  bindingSourceFile: string;
  bindingSiteStartOffset: number;
  bindingSiteEndOffset: number;
  resolutionStrategy: ResolvedBindingProof['resolutionStrategy'];
} {
  return all([
    nonEmpty(value.variableName),
    nonEmpty(value.bindingSourceFile),
    integer(value.bindingSiteStartOffset),
    integer(value.bindingSiteEndOffset),
    strategies.has(String(value.resolutionStrategy)),
  ]);
}

function resolvedChainValid(
  reference: Record<string, unknown>,
  chain: readonly LexicalScopeFact[],
  index: number,
): boolean {
  return all([
    index >= 0,
    index < chain.length,
    chain[0]?.kind === 'source_file',
    bindingReferenceCountsValid(reference),
    reference.scopeChainShown === chain.length,
    reference.scopeChainOmitted === 0,
  ]);
}

function contains(
  scope: LexicalScopeFact,
  startOffset: number,
  endOffset: number,
): boolean {
  return scope.startOffset <= startOffset && scope.endOffset >= endOffset;
}

function strictlyNested(scopes: readonly LexicalScopeFact[]): boolean {
  return scopes.every((scope, index) => {
    const child = scopes[index + 1];
    return !child || contains(scope, child.startOffset, child.endOffset)
      && (scope.startOffset < child.startOffset
        || scope.endOffset > child.endOffset);
  });
}

function deepestContainingScopeIndex(
  chain: readonly LexicalScopeFact[],
  startOffset: number,
  endOffset: number,
): number {
  let result = -1;
  chain.forEach((scope, index) => {
    if (contains(scope, startOffset, endOffset)) result = index;
  });
  return result;
}

function scopeProofValid(
  call: BindingProofCall,
  reference: ResolvedBindingProof,
): boolean {
  const chain = reference.lexicalScopeChain;
  const siteStart = reference.bindingSiteStartOffset;
  const siteEnd = reference.bindingSiteEndOffset;
  const scopeIndex = reference.bindingScopeIndex;
  const deepest = deepestContainingScopeIndex(chain, siteStart, siteEnd);
  const siteScopeValid = reference.resolutionStrategy
    === 'deterministic_reaching_assignment'
    ? deepest >= scopeIndex
    : deepest === scopeIndex;
  return all([
    siteStart >= 0, siteEnd > siteStart, siteEnd <= call.startOffset,
    strictlyNested(chain),
    chain.every((scope) => contains(scope, call.startOffset, call.endOffset)),
    chain.slice(0, scopeIndex + 1).every((scope) =>
      contains(scope, siteStart, siteEnd)),
    siteScopeValid,
  ]);
}

function ownerCompatible(
  call: BindingProofCall,
  target: BindingProofTarget,
): boolean {
  if (target.ownerResolution === 'ownerless_file_scope')
    return target.symbolId === null
      && target.ownerStartOffset === null && target.ownerEndOffset === null;
  return all([
    target.ownerResolution === 'owned_exact',
    target.symbolId !== null,
    integer(target.ownerStartOffset),
    integer(target.ownerEndOffset),
    Number(target.ownerStartOffset) <= target.startOffset,
    Number(target.ownerEndOffset) >= target.endOffset,
    Number(target.ownerStartOffset) <= call.startOffset,
    Number(target.ownerEndOffset) >= call.endOffset,
  ]);
}

function targetMatches(
  call: BindingProofCall,
  reference: ResolvedBindingProof,
  target: BindingProofTarget | undefined,
): boolean {
  if (!target || call.bindingId !== target.id) return false;
  if (reference.resolutionStrategy === 'single_hop_helper_return'
    && !target.singleHopHelperReturn) return false;
  return all([
    target.repoId === call.repoId,
    target.sourceFile === call.sourceFile,
    target.sourceFile === reference.bindingSourceFile,
    target.variableName === reference.variableName,
    target.startOffset === reference.bindingSiteStartOffset,
    target.endOffset === reference.bindingSiteEndOffset,
    ownerCompatible(call, target),
  ]);
}

export function resolvedBindingReferenceProofValid(
  call: BindingProofCall,
  referenceValue: unknown,
  target: BindingProofTarget | undefined,
): boolean {
  const reference = resolvedProof(call, referenceValue);
  return Boolean(reference && scopeProofValid(call, reference)
    && targetMatches(call, reference, target));
}
