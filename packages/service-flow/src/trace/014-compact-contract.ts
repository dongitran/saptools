import type { Db } from '../db/connection.js';
import type {
  DynamicMode,
  TraceOptions,
  TraceResult,
  TraceStart,
} from '../types.js';

export type CompactStatus =
  | 'resolved'
  | 'terminal'
  | 'inferred'
  | 'dynamic'
  | 'ambiguous'
  | 'unresolved'
  | 'cycle';

export type CompactEndpointSide = 'source' | 'target';

export type CompactSemanticEndpoint =
  | { kind: 'operation'; operationId: number }
  | { kind: 'symbol'; symbolId: number }
  | { kind: 'handler_method'; handlerMethodId: number }
  | { kind: 'event'; workspaceId: number; eventName: string }
  | {
      kind: 'target';
      workspaceId: number;
      repositoryId?: number;
      targetKind: string;
      targetId: string;
    }
  | {
      kind: 'call_site';
      workspaceId: number;
      repositoryId: number;
      repositoryName: string;
      sourceFile: string;
      sourceLine: number;
      startOffset?: number;
      endOffset?: number;
      callId: number;
    }
  | {
      kind: 'scope';
      workspaceId: number;
      repositoryId?: number;
      sourceFiles: string[];
      symbolIds: number[];
      structuralKey: string;
    }
  | {
      kind: 'unavailable';
      side: CompactEndpointSide;
      endpointKind: string;
      detailedEdgeIndex: number;
      site?: CompactSourceSite;
    };

export type CompactRemediationCode =
  | 'provide_runtime_variables'
  | 'select_implementation'
  | 'reindex_and_link'
  | 'inspect_detailed_edge';

export interface CompactDecisionTargetInput {
  kind: string;
  id: string;
}

export interface CompactDecisionInput {
  effectiveResolutionStatus?: string;
  effectiveTarget?: CompactDecisionTargetInput;
  persistedResolutionStatus?: string;
  persistedTarget?: CompactDecisionTargetInput;
  missingVariableNames?: string[];
  missingVariableCount?: number;
  dynamicMode?: DynamicMode;
  candidateCount?: number;
  viableCandidateCount?: number;
  rejectedCandidateCount?: number;
  omittedCandidateCount?: number;
  implementationStrategy?: string;
  implementationGuided?: boolean;
  implementationContextual?: boolean;
  reasonCode?: string;
  eventMatchStrategy?: string;
  dispatchCertainty?: string;
  eventSubscriptionCount?: number;
  associationStatus?: string;
  associationBasis?: string;
  eventScope?: string;
  callRole?: string;
  factOrigin?: string;
  roleSiteMatchCount?: number;
  bodyExpansion?: string;
  remediationCode?: CompactRemediationCode;
  remediationHintCount?: number;
}

export interface CompactReferenceInput {
  graphEdgeIds?: Array<number | string>;
  outboundCallIds?: Array<number | string>;
  subscribeCallIds?: Array<number | string>;
  symbolCallIds?: Array<number | string>;
  operationIds?: Array<number | string>;
  symbolIds?: Array<number | string>;
  handlerMethodIds?: Array<number | string>;
}

export interface CompactSourceSite {
  repository?: string;
  sourceFile?: string;
  sourceLine?: number;
  startOffset?: number;
  endOffset?: number;
}

export interface CompactEdgeObservation {
  ordinal: number;
  step: number;
  type: string;
  source: CompactSemanticEndpoint;
  target: CompactSemanticEndpoint;
  status: CompactStatus;
  confidence: number;
  decision?: CompactDecisionInput;
  refs?: CompactReferenceInput;
  site?: CompactSourceSite;
}

export interface CompactTraceObserver {
  record(observation: CompactEdgeObservation): void;
  setWorkspaceId?(workspaceId: number | undefined): void;
}

export class CompactObservationCollector implements CompactTraceObserver {
  readonly observations: CompactEdgeObservation[] = [];
  workspaceId?: number;

  record(observation: CompactEdgeObservation): void {
    this.observations.push(observation);
  }

  setWorkspaceId(workspaceId: number | undefined): void {
    this.workspaceId = workspaceId;
  }
}

export interface CompactSourceContext {
  schemaVersion: number;
  analyzerVersion: string;
  graphGeneration: number;
}

export interface CompactProjectionInput {
  db: Db;
  start: TraceStart;
  options: TraceOptions;
  source: CompactSourceContext;
  trace: TraceResult;
  observations: CompactEdgeObservation[];
}

export interface CompactHintV1 {
  servicePath: string | null;
  operationPath: string | null;
  packageName: string | null;
  repositoryName: string | null;
  candidateFamily: string | null;
  implementationRepo: string | null;
}

export interface CompactStartV1 {
  repo: string | null;
  servicePath: string | null;
  operation: string | null;
  operationPath: string | null;
  handler: string | null;
}

export interface CompactQueryV1 {
  depth: number;
  includeAsync: boolean;
  includeDb: boolean;
  includeExternal: boolean;
  dynamicMode: DynamicMode;
  maxDynamicCandidates: number;
  suppliedVariableNames: string[];
  runtimeValuesOmitted: true;
  implementationRepo: string | null;
  implementationHints: CompactHintV1[];
}

export interface CompactReferenceGroupV1 {
  values: Array<number | string>;
  total: number;
  shown: number;
  omitted: number;
}

export interface CompactReferencesV1 {
  graphEdgeIds?: CompactReferenceGroupV1;
  outboundCallIds?: CompactReferenceGroupV1;
  subscribeCallIds?: CompactReferenceGroupV1;
  symbolCallIds?: CompactReferenceGroupV1;
  operationIds?: CompactReferenceGroupV1;
  symbolIds?: CompactReferenceGroupV1;
  handlerMethodIds?: CompactReferenceGroupV1;
}

export interface CompactDecisionV1 {
  effectiveResolutionStatus?: string;
  effectiveTarget?: string;
  persistedResolutionStatus?: string;
  persistedTarget?: string;
  missingVariableNames?: string[];
  missingVariableCount?: number;
  shownMissingVariableCount?: number;
  omittedMissingVariableCount?: number;
  dynamicMode?: DynamicMode;
  candidateCount?: number;
  viableCandidateCount?: number;
  rejectedCandidateCount?: number;
  omittedCandidateCount?: number;
  implementationStrategy?: string;
  implementationGuided?: boolean;
  implementationContextual?: boolean;
  eventMatchStrategy?: string;
  dispatchCertainty?: string;
  eventSubscriptionCount?: number;
  associationStatus?: string;
  associationBasis?: string;
  eventScope?: string;
  callRole?: string;
  factOrigin?: string;
  roleSiteMatchCount?: number;
  bodyExpansion?: string;
  reasonCode?: string;
  remediationHint?: string;
  omittedRemediationHintCount?: number;
}

export interface CompactEdgeDetailsV1 {
  decision: CompactDecisionV1;
  refs: CompactReferencesV1;
}

export interface CompactDiagnosticDetailsV1 {
  reasonCode?: string;
  missingVariableNames?: string[];
  missingVariableCount?: number;
  shownMissingVariableCount?: number;
  omittedMissingVariableCount?: number;
  candidateCount?: number;
  viableCandidateCount?: number;
  rejectedCandidateCount?: number;
  remediationHint?: string;
  omittedHintCount?: number;
}

export interface CompactProjectedDiagnostic {
  index: number;
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  file?: string;
  line?: number;
  details?: CompactDiagnosticDetailsV1;
}

export type CompactNodeRowV1 = [
  id: string,
  kind: string,
  label: string,
  repo: number | null,
  file: number | null,
  line: number | null,
];

export type CompactEdgeRowV1 = [
  id: string,
  traceOrdinals: number[],
  step: number,
  type: string,
  from: string,
  to: string,
  status: CompactStatus,
  confidence: number,
  count: number,
  details: CompactEdgeDetailsV1 | null,
];

export type CompactDiagnosticRowV1 = [
  fullDiagnosticIndex: number,
  severity: 'error' | 'warning' | 'info',
  code: string,
  message: string,
  file: number | null,
  line: number | null,
  details: CompactDiagnosticDetailsV1 | null,
];

export interface CompactStatusCountsV1 {
  resolved: number;
  terminal: number;
  inferred: number;
  dynamic: number;
  ambiguous: number;
  unresolved: number;
  cycle: number;
}

export interface CompactGraphV1 {
  schema: 'service-flow/compact-graph@1';
  start: CompactStartV1;
  query: CompactQueryV1;
  source: CompactSourceContext;
  summary: {
    completeness: 'complete' | 'partial' | 'blocked';
    fullTraceNodes: number;
    fullTraceEdges: number;
    fullTraceDiagnostics: number;
    nodes: number;
    edges: number;
    collapsedEdges: number;
    statusCounts: CompactStatusCountsV1;
    projection: {
      evidence: 'summary-only';
      syntheticEndpoints: number;
      omittedUnreferencedFullNodes: number;
    };
  };
  repos: string[];
  files: string[];
  nodeColumns: ['id', 'kind', 'label', 'repo', 'file', 'line'];
  nodes: CompactNodeRowV1[];
  edgeColumns: [
    'id', 'traceOrdinals', 'step', 'type', 'from', 'to',
    'status', 'confidence', 'count', 'details',
  ];
  edges: CompactEdgeRowV1[];
  diagnosticColumns: [
    'fullDiagnosticIndex', 'severity', 'code', 'message',
    'file', 'line', 'details',
  ];
  diagnostics: CompactDiagnosticRowV1[];
}
