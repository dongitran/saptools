import type {
  NormalizedODataOperationPath,
  ODataPathIntent,
} from './odata-path-normalizer.js';
import {
  boundCandidateLikeEvidence,
  projectBounded,
  type BoundedProjection,
} from '../utils/000-bounded-projection.js';
import { extractPlaceholderKeys } from '../utils/001-placeholders.js';

export interface LinkedOperationResolution {
  target?: {
    repoName?: string;
    servicePath?: string;
    operationPath?: string;
    operationName?: string;
  };
  candidates: unknown[];
  status: string;
  reasons: string[];
}

export function linkedCallEvidence(
  call: Record<string, unknown>,
  resolution: LinkedOperationResolution,
  servicePath: string | undefined,
  operationPath: string | undefined,
  destination: string | undefined,
  normalized: NormalizedODataOperationPath | undefined,
  intent: ODataPathIntent | undefined,
): Record<string, unknown> {
  const candidates = boundedCallCandidates(resolution.candidates);
  return {
    ...callLocationEvidence(call),
    ...selectedBindingEvidence(call),
    ...routingEvidence(call, servicePath, operationPath, destination, normalized, intent),
    ...candidateEvidence(candidates, resolution),
    outboundEvidence: boundCandidateLikeEvidence(objectJson(call.evidence_json) ?? {}),
    analysisCompleteness: call.unresolved_reason ? 'partial' : 'complete',
    parserWarning: call.unresolved_reason
      ? { code: 'parser_warning', message: call.unresolved_reason }
      : undefined,
  };
}

export function ambiguousPathCandidates(
  pathAnalysis: Record<string, unknown>,
): BoundedProjection<string> {
  const values = Array.isArray(pathAnalysis.candidateRawPaths)
    ? pathAnalysis.candidateRawPaths.filter((value): value is string =>
        typeof value === 'string')
    : [];
  return projectBounded(values, (left, right) => left.localeCompare(right));
}

export function objectJson(value: unknown): Record<string, unknown> | undefined {
  const parsed = parseJson(value);
  return isRecord(parsed) ? parsed : undefined;
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function callLocationEvidence(call: Record<string, unknown>): Record<string, unknown> {
  return {
    sourceFile: call.source_file,
    sourceLine: call.source_line,
    file: call.source_file,
    line: call.source_line,
    callId: call.id,
    repo: call.repoName,
  };
}

function selectedBindingEvidence(call: Record<string, unknown>): Record<string, unknown> {
  if (!call.selectedBindingId) return {};
  return {
    selectedBindingId: call.selectedBindingId,
    selectedBinding: {
      bindingId: call.selectedBindingId,
      alias: call.alias,
      aliasExpr: call.aliasExpr,
      destinationExpr: call.destinationExpr,
      servicePathExpr: call.servicePathExpr,
      sourceFile: call.bindingSourceFile,
      sourceLine: call.bindingSourceLine,
      helperChain: parseJson(call.helperChainJson),
    },
  };
}

function routingEvidence(
  call: Record<string, unknown>,
  servicePath: string | undefined,
  operationPath: string | undefined,
  destination: string | undefined,
  normalized: NormalizedODataOperationPath | undefined,
  intent: ODataPathIntent | undefined,
): Record<string, unknown> {
  const routingPlaceholderKeys = placeholderKeys([
    servicePath,
    destination,
    stringValue(call.aliasExpr),
    stringValue(call.alias),
  ]);
  return {
    serviceAlias: call.alias,
    serviceAliasExpr: call.aliasExpr,
    destination,
    servicePath,
    operationPath,
    rawOperationPath: normalized?.wasInvocation
      ? normalized.rawOperationPath
      : intent?.rawPath,
    normalizedOperationPath: normalized?.wasInvocation
      ? normalized.normalizedOperationPath
      : undefined,
    invocationArguments: normalized?.wasInvocation
      ? normalized.invocationArguments
      : undefined,
    invocationArgumentPlaceholderKeys: normalized?.invocationArgumentPlaceholderKeys.length
      ? normalized.invocationArgumentPlaceholderKeys
      : undefined,
    routingPlaceholderKeys: routingPlaceholderKeys.length
      ? routingPlaceholderKeys
      : undefined,
    odataOperationNormalizationReason: normalized?.normalizationReason,
    odataOperationNormalizationRejectedReason: normalized?.normalizationRejectedReason,
    localServiceName: call.local_service_name,
    localServiceLookup: call.local_service_lookup,
    aliasChain: parseJson(call.alias_chain_json),
    transport: call.call_type === 'local_service_call' ? 'local' : undefined,
    helperChain: parseJson(call.helperChainJson),
    odataPathIntent: intent,
    queryStringPresent: intent?.hasQueryString || undefined,
    queryPlaceholderKeys: intent?.placeholderKeys.length
      ? intent.placeholderKeys
      : undefined,
    bindingHasDynamicExpression: Boolean(Number(call.isDynamic ?? 0)) || undefined,
  };
}

function candidateEvidence(
  candidates: ReturnType<typeof boundedCallCandidates>,
  resolution: LinkedOperationResolution,
): Record<string, unknown> {
  return {
    targetRepo: resolution.target?.repoName,
    targetServicePath: resolution.target?.servicePath,
    targetOperationPath: resolution.target?.operationPath,
    targetOperation: resolution.target?.operationName,
    candidates: candidates.items,
    candidateScores: compactCandidateScores(candidates.items),
    candidateCount: candidates.totalCount,
    shownCandidateCount: candidates.shownCount,
    omittedCandidateCount: candidates.omittedCount,
    candidateScoreCount: candidates.totalCount,
    shownCandidateScoreCount: candidates.shownCount,
    omittedCandidateScoreCount: candidates.omittedCount,
    resolutionStatus: resolution.status,
    resolutionReasons: resolution.reasons,
  };
}

function boundedCallCandidates(
  candidates: unknown[],
): BoundedProjection<Record<string, unknown>> {
  const rows = candidates.flatMap((candidate): Array<Record<string, unknown>> => {
    const row = objectValue(candidate);
    return row ? [row] : [];
  });
  return projectBounded(rows, compareCallCandidate);
}

function compareCallCandidate(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  return Number(right.score ?? 0) - Number(left.score ?? 0)
    || String(left.repoName ?? '').localeCompare(String(right.repoName ?? ''))
    || String(left.servicePath ?? '').localeCompare(String(right.servicePath ?? ''))
    || String(left.operationPath ?? '').localeCompare(String(right.operationPath ?? ''))
    || Number(left.operationId ?? 0) - Number(right.operationId ?? 0);
}

function compactCandidateScores(
  candidates: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return candidates.map((candidate) => ({
    repo: candidate.repoName,
    servicePath: candidate.servicePath,
    operationPath: candidate.operationPath,
    score: candidate.score,
    reasons: Array.isArray(candidate.reasons)
      ? candidate.reasons.filter((reason): reason is string =>
          typeof reason === 'string')
      : ['operation_path_match'],
  }));
}

function placeholderKeys(values: Array<string | undefined>): string[] {
  const keys = values.flatMap(extractPlaceholderKeys);
  return [...new Set(keys)].sort();
}

function parseJson(value: unknown): unknown {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(String(value));
    return parsed;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
