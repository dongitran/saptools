import type { Db } from '../db/connection.js';
import { extractPlaceholders } from '../linker/dynamic-edge-resolver.js';
import { boundCandidateLikeEvidence } from '../utils/000-bounded-projection.js';
import type { ContextBinding } from './008-contextual-runtime-state.js';

export interface TraceContextCall extends Record<string, unknown> {
  service_binding_id?: number;
  evidence_json?: string;
}

type BindingRow = Omit<ContextBinding,
  'bindingId' | 'source' | 'calleeReceiver'> & {
  id?: number;
  symbolId?: number | null;
  variableName?: string;
};

export function parseTraceEvidence(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value || '{}')) as unknown;
    return isRecord(parsed) ? boundCandidateLikeEvidence(parsed) : {};
  } catch {
    return {};
  }
}

export function receiverFromTraceEvidence(value: unknown): string | undefined {
  const evidence = parseTraceEvidence(value);
  return typeof evidence.receiver === 'string' ? evidence.receiver : undefined;
}

export function knownBindingsForCalls(
  db: Db,
  calls: TraceContextCall[],
): Map<string, ContextBinding> {
  const map = new Map<string, ContextBinding>();
  for (const call of calls) addCallBinding(db, map, call);
  return map;
}

export function knownBindingsForScope(
  db: Db,
  repoId: number | undefined,
  symbolIds: Set<number> | undefined,
  files: Set<string> | undefined,
): Map<string, ContextBinding> {
  const map = new Map<string, ContextBinding>();
  if (repoId === undefined) return map;
  const rows = db.prepare(`SELECT b.id,b.symbol_id symbolId,
      b.variable_name variableName,b.alias,b.alias_expr aliasExpr,
      b.destination_expr destinationExpr,b.service_path_expr servicePathExpr,
      b.source_file sourceFile,b.source_line sourceLine,
      req.service_path requireServicePath,req.destination requireDestination
    FROM service_bindings b LEFT JOIN cds_requires req
      ON req.repo_id=b.repo_id AND req.alias=b.alias
    WHERE b.repo_id=?
    ORDER BY b.source_file COLLATE BINARY,b.source_line,b.id`).all(
    repoId,
  ) as BindingRow[];
  for (const row of rows) addScopeBinding(map, row, symbolIds, files);
  return map;
}

export function contextForSymbolCall(
  db: Db,
  symbolCall: Record<string, unknown>,
  callerBindings: Map<string, ContextBinding>,
): Map<string, ContextBinding> {
  const next = new Map<string, ContextBinding>();
  if (callerBindings.size === 0) return next;
  const context = symbolCallContext(db, symbolCall);
  context.args.forEach((argument, index) => addArgumentBindings(
    next, callerBindings, context, argument, index,
  ));
  return next;
}

function addCallBinding(
  db: Db,
  map: Map<string, ContextBinding>,
  call: TraceContextCall,
): void {
  const receiver = receiverFromTraceEvidence(call.evidence_json);
  const bindingId = Number(call.service_binding_id ?? 0);
  if (!receiver || !bindingId) return;
  const row = db.prepare(`SELECT b.id,b.alias,b.alias_expr aliasExpr,
      b.destination_expr destinationExpr,b.service_path_expr servicePathExpr,
      b.source_file sourceFile,b.source_line sourceLine,
      req.service_path requireServicePath,req.destination requireDestination
    FROM service_bindings b LEFT JOIN cds_requires req
      ON req.repo_id=b.repo_id AND req.alias=b.alias WHERE b.id=?`).get(
    bindingId,
  ) as ContextBinding | undefined;
  if (row) map.set(receiver, enrichBinding({
    ...row, bindingId, source: 'local_service_binding', calleeReceiver: receiver,
  }));
}

function addScopeBinding(
  map: Map<string, ContextBinding>,
  row: BindingRow,
  symbolIds: Set<number> | undefined,
  files: Set<string> | undefined,
): void {
  if (!row.variableName) return;
  if (files && !files.has(String(row.sourceFile))) return;
  if (symbolIds?.size && row.symbolId != null
    && !symbolIds.has(Number(row.symbolId))) return;
  const candidate = enrichBinding({
    ...row, bindingId: Number(row.id), source: 'local_service_binding',
    calleeReceiver: row.variableName, resolutionStatus: 'selected',
  });
  const existing = map.get(row.variableName);
  if (!existing) {
    map.set(row.variableName, candidate);
    return;
  }
  map.set(row.variableName, ambiguousBinding(existing, candidate));
}

function ambiguousBinding(
  existing: ContextBinding,
  candidate: ContextBinding,
): ContextBinding {
  const bindingCandidates = uniqueBindingCandidates([
    ...(existing.bindingCandidates ?? [bindingEvidence(existing)]),
    bindingEvidence(candidate),
  ]);
  return {
    ...candidate, bindingId: undefined,
    source: 'ambiguous_local_service_bindings', resolutionStatus: 'ambiguous',
    bindingCandidates,
  };
}

interface SymbolCallContext {
  args: Array<Record<string, unknown>>;
  params: string[];
  parameterBindings: Array<Record<string, unknown>>;
  parameterPropertyAliases: Array<Record<string, unknown>>;
  provenance: Record<string, unknown>;
}

function symbolCallContext(
  db: Db,
  symbolCall: Record<string, unknown>,
): SymbolCallContext {
  const callEvidence = parseTraceEvidence(symbolCall.evidence_json);
  const callee = db.prepare(`SELECT evidence_json evidenceJson,
    source_file sourceFile,start_line startLine FROM symbols WHERE id=?`).get(
    symbolCall.callee_symbol_id,
  ) as { evidenceJson?: string; sourceFile?: string; startLine?: number } | undefined;
  const evidence = parseTraceEvidence(callee?.evidenceJson);
  return {
    args: recordArray(callEvidence.callArguments),
    params: stringArray(evidence.parameters),
    parameterBindings: recordArray(evidence.parameterBindings),
    parameterPropertyAliases: recordArray(evidence.parameterPropertyAliases),
    provenance: {
      callerSite: { sourceFile: String(symbolCall.source_file ?? ''),
        sourceLine: Number(symbolCall.source_line ?? 0) },
      calleeSite: { sourceFile: callee?.sourceFile, sourceLine: callee?.startLine },
    },
  };
}

function addArgumentBindings(
  next: Map<string, ContextBinding>,
  caller: Map<string, ContextBinding>,
  context: SymbolCallContext,
  argument: Record<string, unknown>,
  index: number,
): void {
  const parameterBinding = context.parameterBindings.find(
    (binding) => binding.index === index,
  );
  const parameter = parameterBinding?.kind === 'identifier'
    && typeof parameterBinding.name === 'string'
    ? parameterBinding.name : context.params[index];
  addIdentifierBinding(next, caller, context.provenance, argument, parameter);
  addObjectBindings(next, caller, context, argument, parameterBinding, parameter, index);
  addArrayBindings(next, caller, context.provenance, argument, parameterBinding, index);
}

function addIdentifierBinding(
  next: Map<string, ContextBinding>,
  caller: Map<string, ContextBinding>,
  provenance: Record<string, unknown>,
  argument: Record<string, unknown>,
  parameter: string | undefined,
): void {
  if (argument.kind !== 'identifier' || typeof argument.name !== 'string'
    || !parameter) return;
  const binding = caller.get(argument.name);
  if (binding) next.set(parameter, { ...binding, ...provenance,
    source: 'local_symbol_argument', callerArgument: argument.name,
    calleeParameter: parameter, calleeReceiver: parameter });
}

function addObjectBindings(
  next: Map<string, ContextBinding>,
  caller: Map<string, ContextBinding>,
  context: SymbolCallContext,
  argument: Record<string, unknown>,
  parameterBinding: Record<string, unknown> | undefined,
  parameter: string | undefined,
  index: number,
): void {
  if (argument.kind !== 'object_literal' || !Array.isArray(argument.properties)) return;
  for (const property of recordArray(argument.properties)) addObjectPropertyBinding(
    next, caller, context, property, parameterBinding, parameter, index,
  );
}

function addObjectPropertyBinding(
  next: Map<string, ContextBinding>,
  caller: Map<string, ContextBinding>,
  context: SymbolCallContext,
  property: Record<string, unknown>,
  parameterBinding: Record<string, unknown> | undefined,
  parameter: string | undefined,
  index: number,
): void {
  if (typeof property.property !== 'string' || typeof property.argument !== 'string') return;
  const binding = caller.get(property.argument);
  if (!binding) return;
  const local = objectPatternLocal(parameterBinding, property.property);
  if (local) {
    next.set(local, objectBinding(binding, context.provenance,
      property.property, property.argument, String(index), local,
      'local_symbol_destructured_object_argument'));
    return;
  }
  if (!parameter) return;
  const receiver = `${parameter}.${property.property}`;
  next.set(receiver, objectBinding(binding, context.provenance,
    property.property, property.argument, parameter, receiver,
    'local_symbol_object_argument'));
  addObjectAliases(next, binding, context, property, parameter, receiver);
}

function addObjectAliases(
  next: Map<string, ContextBinding>,
  binding: ContextBinding,
  context: SymbolCallContext,
  property: Record<string, unknown>,
  parameter: string,
  receiver: string,
): void {
  for (const alias of context.parameterPropertyAliases) {
    if (alias.parameter !== parameter || alias.property !== property.property
      || typeof alias.local !== 'string') continue;
    next.set(alias.local, {
      ...objectBinding(binding, context.provenance,
        String(property.property), String(property.argument), parameter,
        alias.local, 'local_symbol_object_parameter_destructure'),
      calleeObjectProperty: receiver,
      calleeLocalDestructuredIdentifier: alias.local,
      parameterPropertyAliasKind: alias.kind,
      parameterPropertyAliasLine: alias.line,
    });
  }
}

function addArrayBindings(
  next: Map<string, ContextBinding>,
  caller: Map<string, ContextBinding>,
  provenance: Record<string, unknown>,
  argument: Record<string, unknown>,
  parameterBinding: Record<string, unknown> | undefined,
  index: number,
): void {
  const arrays = arrayPattern(argument, parameterBinding);
  if (!arrays) return;
  for (const element of arrays.elements)
    addArrayElement(next, caller, provenance, element, arrays.targets, index);
}

function arrayPattern(
  argument: Record<string, unknown>,
  binding: Record<string, unknown> | undefined,
): { elements: Array<Record<string, unknown>>;
  targets: Array<Record<string, unknown>> } | undefined {
  if (argument.kind !== 'array_literal') return undefined;
  if (!Array.isArray(argument.elements)) return undefined;
  if (binding?.kind !== 'array_pattern') return undefined;
  if (!Array.isArray(binding.elements)) return undefined;
  return { elements: recordArray(argument.elements),
    targets: recordArray(binding.elements) };
}

function addArrayElement(
  next: Map<string, ContextBinding>,
  caller: Map<string, ContextBinding>,
  provenance: Record<string, unknown>,
  element: Record<string, unknown>,
  targets: Array<Record<string, unknown>>,
  index: number,
): void {
  if (element.kind !== 'identifier' || typeof element.name !== 'string') return;
  const target = targets.find((item) => item.index === element.index);
  if (typeof target?.local !== 'string') return;
  const binding = caller.get(element.name);
  if (binding) next.set(target.local, { ...binding, ...provenance,
    source: 'local_symbol_destructured_array_argument',
    callerArgument: element.name, calleeParameter: String(index),
    calleeReceiver: target.local });
}

function objectPatternLocal(
  binding: Record<string, unknown> | undefined,
  property: string,
): string | undefined {
  if (binding?.kind !== 'object_pattern' || !Array.isArray(binding.properties)) return undefined;
  const match = recordArray(binding.properties).find(
    (item) => item.property === property && typeof item.local === 'string',
  );
  return typeof match?.local === 'string' ? match.local : undefined;
}

function objectBinding(
  binding: ContextBinding,
  provenance: Record<string, unknown>,
  callerProperty: string,
  callerArgument: string,
  parameter: string,
  receiver: string,
  source: string,
): ContextBinding {
  return { ...binding, ...provenance, source,
    callerProperty, callerArgument,
    calleeParameter: parameter, calleeReceiver: receiver };
}

function enrichBinding(row: ContextBinding): ContextBinding {
  const servicePath = row.servicePathExpr && !hasPlaceholder(row.servicePathExpr)
    ? row.servicePathExpr : !row.servicePathExpr ? row.requireServicePath : undefined;
  const destination = row.destinationExpr && !hasPlaceholder(row.destinationExpr)
    ? row.destinationExpr : !row.destinationExpr ? row.requireDestination : undefined;
  return { ...row, effectiveServicePath: servicePath,
    effectiveDestination: destination };
}

function hasPlaceholder(value: string | undefined): boolean {
  return extractPlaceholders(value).length > 0;
}

function bindingEvidence(binding: ContextBinding): Record<string, unknown> {
  return { bindingId: binding.bindingId, sourceFile: binding.sourceFile,
    sourceLine: binding.sourceLine, alias: binding.alias,
    aliasExpr: binding.aliasExpr, destinationExpr: binding.destinationExpr,
    servicePathExpr: binding.servicePathExpr };
}

function uniqueBindingCandidates(
  candidates: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
