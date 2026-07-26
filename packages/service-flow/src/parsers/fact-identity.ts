import type { ExecutableSymbolFact } from '../types.js';

export const executableOwnerKinds = [
  'event_registration',
  'callback',
  'method',
  'object_method',
  'function',
] as const;

type ExecutableOwnerKind = typeof executableOwnerKinds[number];

export interface OwnerCandidate {
  kind: string;
  qualifiedName: string;
  startOffset: number;
  endOffset: number;
}

export interface OwnerSelection<T extends OwnerCandidate> {
  status: 'resolved' | 'none' | 'ambiguous';
  owner?: T;
  eligibleCount: number;
}

const kindRank = new Map<ExecutableOwnerKind, number>(
  executableOwnerKinds.map((kind, index) => [kind, index]),
);

export function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function containsHalfOpen(
  containerStart: number,
  containerEnd: number,
  childStart: number,
  childEnd: number,
): boolean {
  return containerStart <= childStart && containerEnd >= childEnd;
}

export function isExecutableOwnerKind(kind: string): kind is ExecutableOwnerKind {
  return kindRank.has(kind as ExecutableOwnerKind);
}

function ownerIdentity(candidate: OwnerCandidate): string {
  return [
    candidate.kind,
    candidate.startOffset,
    candidate.endOffset,
    candidate.qualifiedName,
  ].join('\u0000');
}

function compareOwners(left: OwnerCandidate, right: OwnerCandidate): number {
  return (left.endOffset - left.startOffset) - (right.endOffset - right.startOffset)
    || (kindRank.get(left.kind as ExecutableOwnerKind) ?? 99)
      - (kindRank.get(right.kind as ExecutableOwnerKind) ?? 99)
    || left.startOffset - right.startOffset
    || left.endOffset - right.endOffset
    || binaryCompare(left.qualifiedName, right.qualifiedName);
}

function exactRegistration<T extends OwnerCandidate>(
  candidates: T[],
  callStart: number,
  callEnd: number,
): T[] {
  return candidates.filter((candidate) =>
    candidate.kind === 'event_registration'
    && candidate.startOffset === callStart
    && candidate.endOffset === callEnd);
}

export function selectCallOwner<T extends OwnerCandidate>(
  candidates: readonly T[],
  callStart: number,
  callEnd: number,
  preferExactRegistration = false,
): OwnerSelection<T> {
  const contained = candidates.filter((candidate) =>
    isExecutableOwnerKind(candidate.kind)
    && containsHalfOpen(
      candidate.startOffset, candidate.endOffset, callStart, callEnd,
    ));
  const eligible = preferExactRegistration
    ? exactRegistration(contained, callStart, callEnd)
    : contained;
  const pool = eligible;
  if (pool.length === 0) return { status: 'none', eligibleCount: 0 };
  const ordered = [...pool].sort(compareOwners);
  const first = ordered[0];
  if (!first) return { status: 'none', eligibleCount: 0 };
  const duplicates = ordered.filter((candidate) =>
    ownerIdentity(candidate) === ownerIdentity(first));
  if (duplicates.length > 1)
    return { status: 'ambiguous', eligibleCount: pool.length };
  return { status: 'resolved', owner: first, eligibleCount: pool.length };
}

export function executableSymbolCandidates(
  symbols: readonly ExecutableSymbolFact[],
  sourceFile: string,
): ExecutableSymbolFact[] {
  return symbols.filter((symbol) =>
    symbol.sourceFile === sourceFile && isExecutableOwnerKind(symbol.kind));
}
