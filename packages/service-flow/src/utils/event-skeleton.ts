import { sha256Text } from './hashing.js';
import { scanPlaceholderStructure } from './placeholders.js';
import type {
  EventEnvironmentReference,
} from '../parsers/event-environment-reference.js';

export const EVENT_SKELETON_SCHEMA = 'service-flow/event-skeleton@1';
export const EVENT_SKELETON_LITERAL_THRESHOLD = 8;
export const EVENT_SKELETON_TEXT_LIMIT = 512;

export interface EventSkeletonFact {
  schema: typeof EVENT_SKELETON_SCHEMA;
  status: 'complete' | 'malformed' | 'too_large';
  signature: string | null;
  literalSpans: string[];
  holeCount: number;
  sourceKeys: string[];
  canonicalKeys: string[];
  candidateEligible: boolean;
  environmentBindings: EventEnvironmentReference[];
  reason?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) =>
    typeof item === 'string')
    ? value as string[] : undefined;
}

function canonicalKey(signature: string, index: number): string {
  return `event.${signature.slice(0, 16)}.hole${index + 1}`;
}

function skeletonSignature(
  literalSpans: readonly string[],
  holeCount: number,
): string {
  return sha256Text(JSON.stringify({ literalSpans, holeCount }));
}

function completeSkeleton(
  template: string,
): EventSkeletonFact {
  const scan = scanPlaceholderStructure(template);
  if (scan.status === 'malformed') return {
    schema: EVENT_SKELETON_SCHEMA,
    status: 'malformed',
    signature: null,
    literalSpans: [],
    holeCount: 0,
    sourceKeys: [],
    canonicalKeys: [],
    candidateEligible: false,
    environmentBindings: [],
    reason: scan.reason,
  };
  const literals: string[] = [];
  let cursor = 0;
  for (const span of scan.spans) {
    literals.push(template.slice(cursor, span.start));
    cursor = span.end;
  }
  literals.push(template.slice(cursor));
  const signature = skeletonSignature(literals, scan.spans.length);
  return {
    schema: EVENT_SKELETON_SCHEMA,
    status: 'complete',
    signature,
    literalSpans: literals,
    holeCount: scan.spans.length,
    sourceKeys: scan.spans.map((span) => span.key.trim()),
    canonicalKeys: scan.spans.map((_, index) =>
      canonicalKey(signature, index)),
    candidateEligible: scan.spans.length > 0
      && literals.some((literal) =>
        literal.length >= EVENT_SKELETON_LITERAL_THRESHOLD),
    environmentBindings: [],
  };
}

function validCompleteSkeleton(
  item: Record<string, unknown>,
  literals: string[],
  sourceKeys: string[],
  canonicalKeys: string[],
): boolean {
  const holes = item.holeCount;
  const signature = item.signature;
  if (!Number.isInteger(holes) || Number(holes) < 1
    || typeof signature !== 'string'
    || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const count = Number(holes);
  return literals.length === count + 1
    && sourceKeys.length === count
    && canonicalKeys.length === count
    && sourceKeys.every((key) => key.length > 0 && key === key.trim())
    && canonicalKeys.every((key, index) =>
      key === canonicalKey(signature, index))
    && new Set(canonicalKeys).size === canonicalKeys.length
    && signature === skeletonSignature(literals, count)
    && item.candidateEligible === literals.some((literal) =>
      literal.length >= EVENT_SKELETON_LITERAL_THRESHOLD)
    && item.reason === undefined;
}

function validClosedSkeleton(
  item: Record<string, unknown>,
  literals: string[],
  sourceKeys: string[],
  canonicalKeys: string[],
): boolean {
  const reason = item.reason;
  if (item.signature !== null || item.holeCount !== 0
    || item.candidateEligible !== false
    || literals.length > 0 || sourceKeys.length > 0
    || canonicalKeys.length > 0
    || !Array.isArray(item.environmentBindings)
    || item.environmentBindings.length > 0) return false;
  if (item.status === 'too_large')
    return reason === 'event_skeleton_text_limit_exceeded';
  return item.status === 'malformed'
    && typeof reason === 'string' && reason.length > 0;
}

export function parseEventSkeletonFact(
  value: unknown,
): EventSkeletonFact | undefined {
  const item = record(parseJson(value));
  if (!item || item.schema !== EVENT_SKELETON_SCHEMA
    || !['complete', 'malformed', 'too_large'].includes(String(item.status))
    || !Array.isArray(item.environmentBindings)) return undefined;
  const literals = stringArray(item.literalSpans);
  const sourceKeys = stringArray(item.sourceKeys);
  const canonicalKeys = stringArray(item.canonicalKeys);
  if (!literals || !sourceKeys || !canonicalKeys) return undefined;
  const valid = item.status === 'complete'
    ? validCompleteSkeleton(item, literals, sourceKeys, canonicalKeys)
    : validClosedSkeleton(item, literals, sourceKeys, canonicalKeys);
  return valid ? item as unknown as EventSkeletonFact : undefined;
}

export function deriveEventSkeleton(
  template: string | undefined,
): EventSkeletonFact | undefined {
  if (!template || !template.includes('${')) return undefined;
  if (template.length <= EVENT_SKELETON_TEXT_LIMIT)
    return completeSkeleton(template);
  return {
    schema: EVENT_SKELETON_SCHEMA,
    status: 'too_large',
    signature: null,
    literalSpans: [],
    holeCount: 0,
    sourceKeys: [],
    canonicalKeys: [],
    candidateEligible: false,
    environmentBindings: [],
    reason: 'event_skeleton_text_limit_exceeded',
  };
}

export function eventTemplateVariables(
  skeleton: EventSkeletonFact | undefined,
  variables: Record<string, string>,
): Record<string, string> {
  if (!skeleton || skeleton.status !== 'complete') return variables;
  const expanded = { ...variables };
  for (let index = 0; index < skeleton.sourceKeys.length; index += 1) {
    const sourceKey = skeleton.sourceKeys[index];
    const canonicalKeyValue = skeleton.canonicalKeys[index];
    if (!sourceKey || !canonicalKeyValue
      || Object.hasOwn(expanded, sourceKey)
      || !Object.hasOwn(expanded, canonicalKeyValue)) continue;
    expanded[sourceKey] = expanded[canonicalKeyValue] ?? '';
  }
  return expanded;
}

export function eventMissingVariableNames(
  skeleton: EventSkeletonFact | undefined,
  missingSourceKeys: readonly string[],
): string[] {
  const names = new Set(missingSourceKeys);
  if (skeleton?.status === 'complete')
    for (let index = 0; index < skeleton.sourceKeys.length; index += 1) {
      const sourceKey = skeleton.sourceKeys[index];
      const canonical = skeleton.canonicalKeys[index];
      if (sourceKey && canonical && names.has(sourceKey))
        names.add(canonical);
    }
  return [...names].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0);
}
