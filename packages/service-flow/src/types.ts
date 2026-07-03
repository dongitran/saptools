export type RepoKind =
  | 'cap-service'
  | 'cap-db-model'
  | 'helper-package'
  | 'mixed'
  | 'unknown';
export type CallType =
  | 'remote_action'
  | 'remote_query'
  | 'local_db_query'
  | 'external_http'
  | 'async_emit'
  | 'async_subscribe'
  | 'local_service_call'
  | 'unknown';
export type EdgeType =
  | 'REPO_HAS_SERVICE'
  | 'SERVICE_HAS_OPERATION'
  | 'OPERATION_IMPLEMENTED_BY_HANDLER'
  | 'HANDLER_REGISTERED_BY_SERVER'
  | 'HANDLER_CALLS_LOCAL_FUNCTION'
  | 'HANDLER_USES_SERVICE_ALIAS'
  | 'HANDLER_CALLS_REMOTE_OPERATION'
  | 'REMOTE_CALL_RESOLVES_TO_OPERATION'
  | 'LOCAL_CALL_RESOLVES_TO_OPERATION'
  | 'HANDLER_RUNS_DB_QUERY'
  | 'HANDLER_CALLS_EXTERNAL_HTTP'
  | 'HANDLER_EMITS_EVENT'
  | 'EVENT_CONSUMED_BY_HANDLER'
  | 'REPO_IMPORTS_HELPER_PACKAGE'
  | 'HELPER_PACKAGE_PROVIDES_HANDLER'
  | 'DYNAMIC_EDGE_CANDIDATE'
  | 'UNRESOLVED_EDGE';
export interface DiscoveredRepository {
  name: string;
  absolutePath: string;
  relativePath: string;
  isGitRepo: boolean;
}
export interface CdsRequire {
  alias: string;
  kind?: string;
  model?: string;
  destination?: string;
  servicePath?: string;
  requestTimeout?: number;
  rawJson: string;
}
export interface PackageFacts {
  packageName?: string;
  packageVersion?: string;
  dependencies: Record<string, string>;
  cdsRequires: CdsRequire[];
  scripts: Record<string, string>;
}
export interface CdsServiceFact {
  namespace?: string;
  serviceName: string;
  qualifiedName: string;
  servicePath: string;
  isExtend: boolean;
  sourceFile: string;
  sourceLine: number;
  operations: CdsOperationFact[];
}
export interface CdsOperationFact {
  operationType: 'action' | 'function' | 'event';
  operationName: string;
  operationPath: string;
  paramsJson: string;
  returnType?: string;
  sourceFile: string;
  sourceLine: number;
}
export interface HandlerClassFact {
  className: string;
  sourceFile: string;
  sourceLine: number;
  methods: HandlerMethodFact[];
}
export interface HandlerMethodFact {
  methodName: string;
  decoratorKind: string;
  decoratorValue?: string;
  decoratorRawExpression: string;
  sourceFile: string;
  sourceLine: number;
}
export interface HandlerRegistrationFact {
  className?: string;
  importSource?: string;
  registrationFile: string;
  registrationLine: number;
  registrationKind: string;
  confidence: number;
}
export interface ServiceBindingFact {
  variableName: string;
  alias?: string;
  aliasExpr?: string;
  destinationExpr?: string;
  servicePathExpr?: string;
  isDynamic: boolean;
  placeholders: string[];
  sourceFile: string;
  sourceLine: number;
  helperChain?: Array<Record<string, unknown>>;
}
export interface OutboundCallFact {
  callType: CallType;
  sourceSymbolQualifiedName?: string;
  localServiceName?: string;
  localServiceLookup?: string;
  aliasChain?: string[];
  serviceVariableName?: string;
  method?: string;
  operationPathExpr?: string;
  queryEntity?: string;
  eventNameExpr?: string;
  payloadSummary?: string;
  sourceFile: string;
  sourceLine: number;
  confidence: number;
  unresolvedReason?: string;
  evidence?: Record<string, unknown>;
}
export interface ExecutableSymbolFact {
  kind: string;
  localName: string;
  exportedName?: string;
  qualifiedName: string;
  sourceFile: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  exported: boolean;
  importExportEvidence?: Record<string, unknown>;
}
export interface SymbolCallFact {
  callerQualifiedName: string;
  calleeExpression: string;
  calleeLocalName?: string;
  receiverLocalName?: string;
  importSource?: string;
  sourceFile: string;
  sourceLine: number;
  evidence: Record<string, unknown>;
}
export interface GeneratedConstantFact {
  name: string;
  value: string;
  sourceFile: string;
  sourceLine: number;
}
export interface TraceStart {
  repo?: string;
  servicePath?: string;
  operation?: string;
  operationPath?: string;
  handler?: string;
}
export interface TraceEdge {
  step: number;
  type: string;
  from: string;
  to: string;
  evidence: Record<string, unknown>;
  confidence: number;
  unresolvedReason?: string;
}
export interface TraceResult {
  start: TraceStart;
  nodes: Array<Record<string, unknown>>;
  edges: TraceEdge[];
  diagnostics: Array<Record<string, unknown>>;
}
