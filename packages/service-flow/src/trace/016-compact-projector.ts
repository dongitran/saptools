import type { Db } from '../db/connection.js';
import { redactText } from '../utils/redaction.js';
import { compareBinary as binaryCompare } from './010-traversal-scope.js';
import {
  type CompactDecisionTargetInput,
  type CompactProjectedDiagnostic,
  type CompactDecisionV1,
  type CompactDiagnosticRowV1,
  type CompactEdgeDetailsV1,
  type CompactEdgeObservation,
  type CompactEdgeRowV1,
  type CompactGraphV1,
  type CompactProjectionInput,
  type CompactReferenceGroupV1,
  type CompactReferenceInput,
  type CompactReferencesV1,
  type CompactSemanticEndpoint,
  type CompactSourceSite,
  type CompactStatus,
} from './014-compact-contract.js';
import {
  compactCompleteness, compactSafeCode, compactStatusCounts, compactStatusTotal,
  projectCompactDecision, projectCompactDecisionTarget, projectCompactDiagnostics,
  projectCompactQuery, projectCompactStart,
  removeEquivalentCompactPersistedDecision,
} from './020-compact-field-projection.js';

const REFERENCE_LIMIT = 5;

interface ResolvedNode {
  key: string;
  kind: string;
  label: string;
  repo?: string;
  file?: string;
  line?: number;
  synthetic: boolean;
  decisionTarget?: string;
}

interface ResolvedObservation {
  input: CompactEdgeObservation;
  source: ResolvedNode;
  target: ResolvedNode;
  decision: CompactDecisionV1;
}

interface EdgeAggregate {
  source: ResolvedNode;
  target: ResolvedNode;
  step: number;
  type: string;
  status: CompactStatus;
  confidence: number;
  decision: CompactDecisionV1;
  ordinals: number[];
  refs: CompactReferenceInput[];
  site?: CompactSourceSite;
}

export function projectCompactGraph(input: CompactProjectionInput): CompactGraphV1 {
  validateObservationOrdinals(input.observations, input.trace.edges.length);
  const resolved = input.observations.map((item) => resolveObservation(input.db, item));
  const diagnostics = projectCompactDiagnostics(input.trace.diagnostics);
  const aggregates = aggregateObservations(resolved);
  const nodes = canonicalNodes(resolved);
  const repos = sortedUnique(nodes.flatMap((node) => node.repo ? [node.repo] : []));
  const files = sortedUnique([
    ...nodes.flatMap((node) => node.file ? [node.file] : []),
    ...diagnostics.flatMap((item) => item.file ? [item.file] : []),
  ]);
  const nodeRows = compactNodeRows(nodes, repos, files);
  const edgeRows = compactEdgeRows(aggregates, nodes);
  const diagnosticRows = compactDiagnosticRows(diagnostics, files);
  const result = compactResult(input, nodes, nodeRows, edgeRows, diagnosticRows, repos, files);
  validateCompactResult(result);
  return result;
}

function resolveObservation(db: Db, input: CompactEdgeObservation): ResolvedObservation {
  const target = resolveEndpoint(db, input.target, input.ordinal, 'target', input.site);
  return {
    input,
    source: resolveEndpoint(db, input.source, input.ordinal, 'source', input.site),
    target,
    decision: observationDecision(db, input, target),
  };
}

function observationDecision(
  db: Db,
  input: CompactEdgeObservation,
  target: ResolvedNode,
): CompactDecisionV1 {
  const decision = projectCompactDecision(input.decision);
  if (decision.effectiveResolutionStatus && target.decisionTarget)
    decision.effectiveTarget = target.decisionTarget;
  if (decision.persistedResolutionStatus && input.decision?.persistedTarget) {
    const persisted = persistedDecisionTarget(db, input.decision.persistedTarget);
    if (persisted) decision.persistedTarget = persisted;
  }
  removeEquivalentCompactPersistedDecision(decision);
  return decision;
}

function persistedDecisionTarget(
  db: Db,
  target: CompactDecisionTargetInput,
): string | undefined {
  const numeric = numericId(target.id);
  if (target.kind === 'operation' && numeric !== undefined)
    return operationNode(db, numeric)?.decisionTarget;
  if (target.kind === 'symbol' && numeric !== undefined)
    return symbolNode(db, numeric)?.decisionTarget;
  if (target.kind === 'handler_method' && numeric !== undefined)
    return handlerNode(db, numeric)?.decisionTarget;
  return projectCompactDecisionTarget(target.kind, target.id);
}

function resolveEndpoint(
  db: Db,
  endpoint: CompactSemanticEndpoint,
  ordinal: number,
  side: 'source' | 'target',
  site: CompactSourceSite | undefined,
): ResolvedNode {
  if (endpoint.kind === 'operation')
    return resolvedOrUnavailable(operationNode(db, endpoint.operationId), side,
      'operation', ordinal, site);
  if (endpoint.kind === 'symbol')
    return resolvedOrUnavailable(symbolNode(db, endpoint.symbolId), side,
      'symbol', ordinal, site);
  if (endpoint.kind === 'handler_method')
    return resolvedOrUnavailable(handlerNode(db, endpoint.handlerMethodId), side,
      'handler_method', ordinal, site);
  if (endpoint.kind === 'event') return eventNode(endpoint.workspaceId, endpoint.eventName);
  if (endpoint.kind === 'target') return targetNode(db, endpoint, ordinal, side, site);
  if (endpoint.kind === 'call_site') return callSiteNode(db, endpoint);
  if (endpoint.kind === 'scope') return scopeNode(db, endpoint);
  return unavailableNode(endpoint.side, endpoint.endpointKind,
    endpoint.detailedEdgeIndex, endpoint.site ?? site);
}

function resolvedOrUnavailable(
  node: ResolvedNode | undefined,
  side: 'source' | 'target',
  kind: string,
  ordinal: number,
  site?: CompactSourceSite,
): ResolvedNode {
  return node ?? unavailableNode(side, kind, ordinal, site);
}

function operationNode(db: Db, operationId: number): ResolvedNode | undefined {
  const row = db.prepare(`SELECT o.id,o.operation_name operationName,
      o.operation_path operationPath,o.source_file sourceFile,o.source_line sourceLine,
      s.service_path servicePath,r.workspace_id workspaceId,r.relative_path relativePath,
      r.name repoName
    FROM cds_operations o JOIN cds_services s ON s.id=o.service_id
    JOIN repositories r ON r.id=s.repo_id WHERE o.id=?`).get(operationId);
  if (!row) return undefined;
  const operationPath = stringValue(row.operationPath);
  const servicePath = stringValue(row.servicePath);
  const repo = repositoryLabel(row);
  const workspaceId = numberValue(row.workspaceId);
  if (!operationPath) return undefined;
  if (!servicePath) return undefined;
  if (!repo) return undefined;
  if (workspaceId === undefined) return undefined;
  const operationName = stringValue(row.operationName);
  return {
    key: canonicalKey('operation', workspaceId, repo, servicePath, operationPath),
    kind: 'operation',
    label: `${servicePath}:${operationName || operationPath}`,
    repo,
    file: stringValue(row.sourceFile),
    line: numberValue(row.sourceLine),
    synthetic: false,
    decisionTarget: projectCompactDecisionTarget('operation',
      `${repo}:${servicePath}:${operationPath}`),
  };
}

function symbolNode(db: Db, symbolId: number): ResolvedNode | undefined {
  const row = db.prepare(`SELECT s.id,s.kind,s.qualified_name qualifiedName,
      s.source_file sourceFile,s.start_line startLine,s.start_offset startOffset,
      s.end_offset endOffset,r.workspace_id workspaceId,r.relative_path relativePath,
      r.name repoName FROM symbols s JOIN repositories r ON r.id=s.repo_id
    WHERE s.id=?`).get(symbolId);
  return symbolNodeFromRow(row);
}

function symbolNodeFromRow(row: Record<string, unknown> | undefined): ResolvedNode | undefined {
  if (!row) return undefined;
  const name = stringValue(row.qualifiedName);
  const repo = repositoryLabel(row);
  const file = stringValue(row.sourceFile);
  const workspaceId = numberValue(row.workspaceId);
  if (!name) return undefined;
  if (!repo) return undefined;
  if (!file) return undefined;
  if (workspaceId === undefined) return undefined;
  const startOffset = numberValue(row.startOffset);
  const endOffset = numberValue(row.endOffset);
  return {
    key: canonicalKey('symbol', workspaceId, repo, file,
      startOffset, endOffset, name),
    kind: 'symbol', label: name, repo, file,
    line: numberValue(row.startLine), synthetic: false,
    decisionTarget: projectCompactDecisionTarget('symbol',
      `${repo}:${file}:${startOffset ?? ''}:${endOffset ?? ''}:${name}`),
  };
}

function handlerNode(db: Db, handlerMethodId: number): ResolvedNode | undefined {
  const symbol = db.prepare(`SELECT s.kind,s.qualified_name qualifiedName,
      s.source_file sourceFile,s.start_line startLine,s.start_offset startOffset,
      s.end_offset endOffset,r.workspace_id workspaceId,r.relative_path relativePath,
      r.name repoName
    FROM handler_methods hm JOIN handler_classes hc ON hc.id=hm.handler_class_id
    JOIN repositories r ON r.id=hc.repo_id LEFT JOIN symbols s
      ON s.repo_id=hc.repo_id AND s.source_file=hc.source_file
      AND s.qualified_name=hc.class_name || '.' || hm.method_name
      AND s.start_line=hm.source_line WHERE hm.id=?
    ORDER BY s.id LIMIT 1`).get(handlerMethodId);
  const resolved = symbolNodeFromRow(symbol);
  return resolved ?? standaloneHandlerNode(db, handlerMethodId);
}

function standaloneHandlerNode(db: Db, handlerMethodId: number): ResolvedNode | undefined {
  const row = db.prepare(`SELECT hm.method_name methodName,hm.source_file sourceFile,
      hm.source_line sourceLine,hc.class_name className,r.workspace_id workspaceId,
      r.relative_path relativePath,r.name repoName FROM handler_methods hm
    JOIN handler_classes hc ON hc.id=hm.handler_class_id
    JOIN repositories r ON r.id=hc.repo_id WHERE hm.id=?`).get(handlerMethodId);
  if (!row) return undefined;
  const methodName = stringValue(row.methodName);
  const className = stringValue(row.className);
  const repo = repositoryLabel(row);
  const file = stringValue(row.sourceFile);
  const workspaceId = numberValue(row.workspaceId);
  if (!methodName) return undefined;
  if (!className) return undefined;
  if (!repo) return undefined;
  if (!file) return undefined;
  if (workspaceId === undefined) return undefined;
  const sourceLine = numberValue(row.sourceLine);
  return {
    key: canonicalKey('handler_method', workspaceId, repo, file,
      sourceLine, className, methodName),
    kind: 'handler_method', label: `${className}.${methodName}`, repo, file,
    line: sourceLine, synthetic: false,
    decisionTarget: projectCompactDecisionTarget('handler_method',
      `${repo}:${file}:${sourceLine ?? ''}:${className}.${methodName}`),
  };
}

function eventNode(workspaceId: number, eventName: string): ResolvedNode {
  return {
    key: canonicalKey('event', workspaceId, eventName),
    kind: 'event', label: eventName, synthetic: false,
    decisionTarget: projectCompactDecisionTarget('event', eventName),
  };
}

function targetNode(
  db: Db,
  endpoint: Extract<CompactSemanticEndpoint, { kind: 'target' }>,
  ordinal: number,
  side: 'source' | 'target',
  site: CompactSourceSite | undefined,
): ResolvedNode {
  const linked = linkedTargetNode(db, endpoint.targetKind, endpoint.targetId);
  if (linked !== undefined)
    return linked ?? unavailableNode(side, endpoint.targetKind, ordinal, site);
  const repo = endpoint.repositoryId === undefined
    ? undefined : repositoryById(db, endpoint.repositoryId);
  return {
    key: canonicalKey('target', endpoint.workspaceId, repo,
      endpoint.targetKind, endpoint.targetId),
    kind: compactTargetKind(endpoint.targetKind),
    label: endpoint.targetId || endpoint.targetKind,
    repo,
    synthetic: false,
    decisionTarget: projectCompactDecisionTarget(endpoint.targetKind, endpoint.targetId),
  };
}

function linkedTargetNode(
  db: Db,
  kind: string,
  id: string,
): ResolvedNode | null | undefined {
  const numeric = numericId(id);
  if (kind === 'operation') {
    if (numeric === undefined) return null;
    return operationNode(db, numeric) ?? null;
  }
  if (kind === 'symbol') {
    if (numeric === undefined) return null;
    return symbolNode(db, numeric) ?? null;
  }
  if (kind === 'handler_method') {
    if (numeric === undefined) return null;
    return handlerNode(db, numeric) ?? null;
  }
  return undefined;
}

function callSiteNode(
  db: Db,
  endpoint: Extract<CompactSemanticEndpoint, { kind: 'call_site' }>,
): ResolvedNode {
  const repo = repositoryById(db, endpoint.repositoryId) ?? endpoint.repositoryName;
  const span = endpoint.startOffset === undefined || endpoint.endOffset === undefined
    ? ['line', endpoint.sourceLine] : [endpoint.startOffset, endpoint.endOffset];
  return {
    key: canonicalKey('call_site', endpoint.workspaceId, repo,
      endpoint.sourceFile, ...span, endpoint.callId),
    kind: 'call_site',
    label: `${repo}:${endpoint.sourceFile}:${endpoint.sourceLine}`,
    repo, file: endpoint.sourceFile, line: endpoint.sourceLine, synthetic: false,
    decisionTarget: projectCompactDecisionTarget('call_site',
      `${repo}:${endpoint.sourceFile}:${span.join(':')}`),
  };
}

function scopeNode(
  db: Db,
  endpoint: Extract<CompactSemanticEndpoint, { kind: 'scope' }>,
): ResolvedNode {
  const repo = endpoint.repositoryId === undefined
    ? undefined : repositoryById(db, endpoint.repositoryId);
  const files = sortedUnique(endpoint.sourceFiles);
  const symbols = sortedUnique(endpoint.symbolIds.flatMap((id) => {
    const key = symbolNode(db, id)?.key;
    return key ? [key] : [];
  }));
  const identity = canonicalKey('scope', endpoint.workspaceId, repo, files, symbols);
  return {
    key: symbols.length > 0 || files.length > 0 ? identity
      : canonicalKey('scope', endpoint.workspaceId, repo, endpoint.structuralKey),
    kind: 'scope',
    label: repo ? `scope:${repo}` : 'scope:workspace',
    repo, file: files.length === 1 ? files[0] : undefined,
    synthetic: false,
    decisionTarget: projectCompactDecisionTarget('scope', identity),
  };
}

function unavailableNode(
  side: 'source' | 'target',
  endpointKind: string,
  ordinal: number,
  site?: CompactSourceSite,
): ResolvedNode {
  return {
    key: canonicalKey('unavailable', side, endpointKind,
      site?.repository, site?.sourceFile, site?.startOffset,
      site?.endOffset, site?.sourceLine, ordinal),
    kind: 'synthetic',
    label: `${side}:${compactSafeCode(endpointKind) ?? 'unavailable'}`,
    repo: site?.repository,
    file: site?.sourceFile,
    line: site?.sourceLine,
    synthetic: true,
  };
}

function aggregateObservations(items: ResolvedObservation[]): EdgeAggregate[] {
  const groups = new Map<string, EdgeAggregate>();
  for (const item of items) {
    const key = aggregationKey(item);
    const current = groups.get(key);
    if (current) appendAggregate(current, item);
    else groups.set(key, createAggregate(item));
  }
  return [...groups.values()].map(finalizeAggregate);
}

function aggregationKey(item: ResolvedObservation): string {
  return JSON.stringify([
    item.input.step, item.input.type, item.source.key, item.target.key,
    item.input.status, normalizedConfidence(item.input.confidence), item.decision,
  ]);
}

function createAggregate(item: ResolvedObservation): EdgeAggregate {
  return {
    source: item.source, target: item.target, step: item.input.step,
    type: item.input.type, status: item.input.status,
    confidence: normalizedConfidence(item.input.confidence),
    decision: item.decision, ordinals: [item.input.ordinal],
    refs: item.input.refs ? [item.input.refs] : [], site: item.input.site,
  };
}

function appendAggregate(group: EdgeAggregate, item: ResolvedObservation): void {
  group.ordinals.push(item.input.ordinal);
  if (item.input.refs) group.refs.push(item.input.refs);
  if (compareSite(item.input.site, group.site) < 0) group.site = item.input.site;
}

function finalizeAggregate(group: EdgeAggregate): EdgeAggregate {
  group.ordinals.sort((left, right) => left - right);
  return group;
}

function canonicalNodes(items: ResolvedObservation[]): ResolvedNode[] {
  const nodes = new Map<string, ResolvedNode>();
  for (const node of items.flatMap((item) => [item.source, item.target])) {
    const existing = nodes.get(node.key);
    if (!existing || compareNodeBody(node, existing) < 0) nodes.set(node.key, node);
  }
  return [...nodes.values()].sort((left, right) => binaryCompare(left.key, right.key));
}

function compactNodeRows(
  nodes: ResolvedNode[],
  repos: string[],
  files: string[],
): CompactGraphV1['nodes'] {
  const repoIndexes = indexMap(repos);
  const fileIndexes = indexMap(files);
  return nodes.map((node, index) => [
    `n${index}`, node.kind, redactText(node.label),
    node.repo === undefined ? null : repoIndexes.get(node.repo) ?? null,
    node.file === undefined ? null : fileIndexes.get(node.file) ?? null,
    node.line ?? null,
  ]);
}

function compactEdgeRows(
  groups: EdgeAggregate[],
  nodes: ResolvedNode[],
): CompactGraphV1['edges'] {
  const nodeIndexes = new Map(nodes.map((node, index) => [node.key, index]));
  const sorted = [...groups].sort((left, right) => compareAggregate(left, right, nodeIndexes));
  return sorted.map((group, index) => edgeRow(group, index, nodeIndexes));
}

function edgeRow(
  group: EdgeAggregate,
  index: number,
  nodeIndexes: Map<string, number>,
): CompactEdgeRowV1 {
  const source = nodeIndexes.get(group.source.key);
  const target = nodeIndexes.get(group.target.key);
  if (source === undefined || target === undefined) throw compactError('edge_node_missing');
  return [
    `e${index}`, group.ordinals, group.step, group.type, `n${source}`, `n${target}`,
    group.status, group.confidence, group.ordinals.length, edgeDetails(group),
  ];
}

function edgeDetails(group: EdgeAggregate): CompactEdgeDetailsV1 | null {
  const refs = projectReferences(group.refs);
  if (Object.keys(group.decision).length === 0 && Object.keys(refs).length === 0) return null;
  return { decision: group.decision, refs };
}

function projectReferences(values: CompactReferenceInput[]): CompactReferencesV1 {
  const out: CompactReferencesV1 = {};
  setReference(out, 'graphEdgeIds', values.flatMap((item) => item.graphEdgeIds ?? []));
  setReference(out, 'outboundCallIds', values.flatMap((item) => item.outboundCallIds ?? []));
  setReference(out, 'subscribeCallIds', values.flatMap((item) => item.subscribeCallIds ?? []));
  setReference(out, 'symbolCallIds', values.flatMap((item) => item.symbolCallIds ?? []));
  setReference(out, 'operationIds', values.flatMap((item) => item.operationIds ?? []));
  setReference(out, 'symbolIds', values.flatMap((item) => item.symbolIds ?? []));
  setReference(out, 'handlerMethodIds', values.flatMap((item) => item.handlerMethodIds ?? []));
  return out;
}

function setReference(
  out: CompactReferencesV1,
  key: keyof CompactReferencesV1,
  values: Array<number | string>,
): void {
  const unique = uniqueReferences(values);
  if (unique.length === 0) return;
  const shown = unique.slice(0, REFERENCE_LIMIT);
  out[key] = {
    values: shown, total: unique.length, shown: shown.length,
    omitted: unique.length - shown.length,
  } satisfies CompactReferenceGroupV1;
}

function compactDiagnosticRows(
  diagnostics: CompactProjectedDiagnostic[],
  files: string[],
): CompactDiagnosticRowV1[] {
  const fileIndexes = indexMap(files);
  return diagnostics.map((item) => [
    item.index, item.severity, item.code, item.message,
    item.file === undefined ? null : fileIndexes.get(item.file) ?? null,
    item.line ?? null, item.details ?? null,
  ]);
}

function compactResult(
  input: CompactProjectionInput,
  resolvedNodes: ResolvedNode[],
  nodes: CompactGraphV1['nodes'],
  edges: CompactGraphV1['edges'],
  diagnostics: CompactGraphV1['diagnostics'],
  repos: string[],
  files: string[],
): CompactGraphV1 {
  const statusCounts = compactStatusCounts(input.observations);
  return {
    schema: 'service-flow/compact-graph@1',
    start: projectCompactStart(input.start),
    query: projectCompactQuery(input.options),
    source: input.source,
    summary: {
      completeness: compactCompleteness(statusCounts, diagnostics),
      fullTraceNodes: input.trace.nodes.length,
      fullTraceEdges: input.trace.edges.length,
      fullTraceDiagnostics: input.trace.diagnostics.length,
      nodes: nodes.length, edges: edges.length,
      collapsedEdges: input.trace.edges.length - edges.length,
      statusCounts,
      projection: {
        evidence: 'summary-only',
        syntheticEndpoints: resolvedNodes.filter((node) => node.synthetic).length,
        omittedUnreferencedFullNodes: omittedDetailedNodeCount(input),
      },
    },
    repos, files,
    nodeColumns: ['id', 'kind', 'label', 'repo', 'file', 'line'],
    nodes,
    edgeColumns: ['id', 'traceOrdinals', 'step', 'type', 'from', 'to',
      'status', 'confidence', 'count', 'details'],
    edges,
    diagnosticColumns: ['fullDiagnosticIndex', 'severity', 'code', 'message',
      'file', 'line', 'details'],
    diagnostics,
  };
}

function omittedDetailedNodeCount(input: CompactProjectionInput): number {
  const referenced = new Set(input.observations.flatMap((item) => [
    ...detailedNodeIds(item.source), ...detailedNodeIds(item.target),
  ]));
  return input.trace.nodes.filter((node) => {
    const id = typeof node.id === 'string' ? node.id : undefined;
    return id === undefined || !referenced.has(id);
  }).length;
}

function detailedNodeIds(endpoint: CompactSemanticEndpoint): string[] {
  if (endpoint.kind === 'operation') return [`operation:${endpoint.operationId}`];
  if (endpoint.kind === 'symbol') return [`symbol:${endpoint.symbolId}`];
  if (endpoint.kind === 'handler_method')
    return [`handler_method:${endpoint.handlerMethodId}`];
  if (endpoint.kind === 'event') return [`event:${endpoint.eventName}`];
  if (endpoint.kind === 'target') return [`${endpoint.targetKind}:${endpoint.targetId}`];
  if (endpoint.kind === 'call_site') return [`call:${endpoint.callId}`];
  if (endpoint.kind === 'scope')
    return endpoint.symbolIds.map((symbolId) => `symbol:${symbolId}`);
  return [];
}

function validateObservationOrdinals(
  observations: CompactEdgeObservation[],
  fullEdgeCount: number,
): void {
  const ordinals = observations.map((item) => item.ordinal).sort((left, right) => left - right);
  if (ordinals.length !== fullEdgeCount) throw compactError('observation_count_mismatch');
  if (ordinals.some((value, index) => value !== index))
    throw compactError('trace_ordinal_partition_invalid');
}

function validateCompactResult(result: CompactGraphV1): void {
  if (result.summary.nodes !== result.nodes.length) throw compactError('node_count_mismatch');
  if (result.summary.edges !== result.edges.length) throw compactError('edge_count_mismatch');
  const statusTotal = compactStatusTotal(result.summary.statusCounts);
  if (statusTotal !== result.summary.fullTraceEdges) throw compactError('status_count_mismatch');
  const edgeTotal = result.edges.reduce((sum, edge) => sum + edge[8], 0);
  if (edgeTotal !== result.summary.fullTraceEdges) throw compactError('edge_member_count_mismatch');
  if (result.edges.some((edge) => edge.length !== 10 || edge[8] !== edge[1].length))
    throw compactError('edge_tuple_invalid');
  if (result.nodes.some((node) => node.length !== 6)) throw compactError('node_tuple_invalid');
  if (result.diagnostics.some((item) => item.length !== 7)) throw compactError('diagnostic_tuple_invalid');
  validateResultOrdinals(result);
}

function validateResultOrdinals(result: CompactGraphV1): void {
  const ordinals = result.edges.flatMap((edge) => edge[1]).sort((left, right) => left - right);
  if (ordinals.some((value, index) => value !== index)
    || ordinals.length !== result.summary.fullTraceEdges)
    throw compactError('output_trace_ordinal_partition_invalid');
  if (result.summary.collapsedEdges !== result.summary.fullTraceEdges - result.summary.edges)
    throw compactError('collapsed_edge_count_mismatch');
}

function compareAggregate(
  left: EdgeAggregate,
  right: EdgeAggregate,
  nodeIndexes: Map<string, number>,
): number {
  return left.step - right.step
    || indexFor(nodeIndexes, left.source.key) - indexFor(nodeIndexes, right.source.key)
    || indexFor(nodeIndexes, left.target.key) - indexFor(nodeIndexes, right.target.key)
    || binaryCompare(left.type, right.type)
    || binaryCompare(left.status, right.status)
    || compareSite(left.site, right.site)
    || (left.ordinals[0] ?? 0) - (right.ordinals[0] ?? 0);
}

function compareSite(left: CompactSourceSite | undefined, right: CompactSourceSite | undefined): number {
  return binaryCompare(siteSortKey(left), siteSortKey(right));
}

function siteSortKey(site: CompactSourceSite | undefined): string {
  return JSON.stringify([
    site?.repository ?? '', site?.sourceFile ?? '',
    sortableNumber(site?.startOffset), sortableNumber(site?.endOffset),
    sortableNumber(site?.sourceLine),
  ]);
}

function sortableNumber(value: number | undefined): string {
  return value === undefined ? 'z' : `n${String(value).padStart(16, '0')}`;
}

function compareNodeBody(left: ResolvedNode, right: ResolvedNode): number {
  return binaryCompare(JSON.stringify([
    left.kind, left.label, left.repo, left.file, left.line,
  ]), JSON.stringify([
    right.kind, right.label, right.repo, right.file, right.line,
  ]));
}

function compactTargetKind(kind: string): string {
  if (kind === 'db_entity') return 'database_entity';
  if (kind === 'operation_candidate') return 'dynamic_target';
  if (kind === 'symbol_reference' || kind === 'subscription_handler')
    return 'unresolved_target';
  return compactSafeCode(kind) ?? 'target';
}

function repositoryById(db: Db, repositoryId: number): string | undefined {
  const row = db.prepare('SELECT relative_path relativePath,name repoName FROM repositories WHERE id=?')
    .get(repositoryId);
  return repositoryLabel(row);
}

function repositoryLabel(row: Record<string, unknown> | undefined): string | undefined {
  return stringValue(row?.relativePath) ?? stringValue(row?.repoName);
}

function normalizedConfidence(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function numericId(value: string): number | undefined {
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function uniqueReferences(values: Array<number | string>): Array<number | string> {
  const unique = new Map(values.map((value) => [`${typeof value}:${String(value)}`, value]));
  return [...unique.values()].sort((left, right) => {
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return binaryCompare(`${typeof left}:${String(left)}`, `${typeof right}:${String(right)}`);
  });
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(binaryCompare);
}

function canonicalKey(...parts: unknown[]): string {
  return JSON.stringify(parts);
}

function indexMap(values: string[]): Map<string, number> {
  return new Map(values.map((value, index) => [value, index]));
}

function indexFor(values: Map<string, number>, key: string): number {
  const value = values.get(key);
  if (value === undefined) throw compactError('canonical_node_index_missing');
  return value;
}

function compactError(code: string): Error {
  return new Error(`compact_graph_invariant:${code}`);
}
