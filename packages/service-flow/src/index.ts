export { discoverRepositories } from './discovery/discover-repositories.js';
export { parsePackageJson } from './parsers/package-json-parser.js';
export { parseCdsFile } from './parsers/cds-parser.js';
export { parseDecorators } from './parsers/decorator-parser.js';
export { parseHandlerRegistrations } from './parsers/handler-registration-parser.js';
export { parseServiceBindings } from './parsers/service-binding-parser.js';
export { parseOutboundCalls } from './parsers/outbound-call-parser.js';
export { parseGeneratedConstants } from './parsers/generated-constants-parser.js';
export { linkWorkspace } from './linker/cross-repo-linker.js';
export { applyVariables, extractPlaceholders, substituteVariables } from './linker/dynamic-edge-resolver.js';
export type { RuntimeSubstitution } from './linker/dynamic-edge-resolver.js';
export { trace } from './trace/trace-engine.js';
export {
  compactTrace,
  traceAndCompact,
} from './trace/018-compact-trace.js';
export type { CompactTraceExecution } from './trace/018-compact-trace.js';
export type {
  CompactDecisionV1,
  CompactDiagnosticDetailsV1,
  CompactDiagnosticRowV1,
  CompactEdgeDetailsV1,
  CompactEdgeRowV1,
  CompactGraphV1,
  CompactHintV1,
  CompactNodeRowV1,
  CompactQueryV1,
  CompactReferenceGroupV1,
  CompactReferencesV1,
  CompactSourceContext,
  CompactStartV1,
  CompactStatus,
  CompactStatusCountsV1,
} from './trace/014-compact-contract.js';
export { parseImplementationHint } from './trace/implementation-hints.js';
export type { DynamicMode, ImplementationHint, TraceOptions } from './types.js';
export { redactValue, redactText } from './utils/redaction.js';
