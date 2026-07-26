import ts from 'typescript';
import type {
  ExecutableSymbolFact,
  OutboundCallFact,
  ServiceBindingFact,
  SymbolCallFact,
} from '../types.js';
import {
  executableSymbolCandidates,
  selectCallOwner,
} from './fact-identity.js';
import { reconcileEventSubscriptions } from './event-subscription-facts.js';
import { reconcileBindingAndCallIdentity } from './binding-identity.js';
import type { ClassifiedOutboundCall } from './outbound-call-parser.js';

export interface ReconciledSourceFacts {
  bindings: ServiceBindingFact[];
  outboundCalls: OutboundCallFact[];
  symbols: ExecutableSymbolFact[];
  symbolCalls: SymbolCallFact[];
  classifications: ClassifiedOutboundCall[];
}

function callKey(call: Pick<
  OutboundCallFact,
  'callType' | 'callSiteStartOffset' | 'callSiteEndOffset'
>): string {
  return `${call.callType}:${call.callSiteStartOffset}:${call.callSiteEndOffset}`;
}

function mergedOutboundCalls(
  existing: readonly OutboundCallFact[],
  classifications: readonly ClassifiedOutboundCall[],
): OutboundCallFact[] {
  const classifiedKeys = new Set(
    classifications.map((item) => callKey(item.fact)),
  );
  return [
    ...classifications.map((item) => item.fact),
    ...existing.filter((call) => !classifiedKeys.has(callKey(call))),
  ];
}

function exactSymbolCallOwner(
  call: SymbolCallFact,
  symbols: readonly ExecutableSymbolFact[],
): ExecutableSymbolFact | undefined {
  const start = call.callSiteStartOffset;
  const end = call.callSiteEndOffset;
  if (start === undefined || end === undefined) return undefined;
  const selected = selectCallOwner(
    executableSymbolCandidates(symbols, call.sourceFile),
    start,
    end,
    call.callRole === 'event_subscribe_handler',
  );
  if (selected.status === 'ambiguous')
    throw new Error('invalid_prepared_repository_snapshot:symbol_call_owner_ambiguous');
  if (call.callRole === 'event_subscribe_handler' && !selected.owner)
    throw new Error('invalid_prepared_repository_snapshot:handler_owner_missing');
  return selected.owner;
}

export function reconcileSymbolCallOwners(
  calls: readonly SymbolCallFact[],
  symbols: readonly ExecutableSymbolFact[],
): SymbolCallFact[] {
  return calls.flatMap((call) => {
    const owner = exactSymbolCallOwner(call, symbols);
    if (!owner) return [];
    return [{
      ...call,
      callerQualifiedName: owner.qualifiedName,
      evidence: {
        ...call.evidence,
        caller: owner.qualifiedName,
        callerResolution: 'full_span_containment',
      },
    }];
  });
}

export function reconcileSourceFacts(
  source: ts.SourceFile,
  classifications: readonly ClassifiedOutboundCall[],
  bindings: readonly ServiceBindingFact[],
  outboundCalls: readonly OutboundCallFact[],
  symbols: readonly ExecutableSymbolFact[],
  symbolCalls: readonly SymbolCallFact[],
): ReconciledSourceFacts {
  const events = reconcileEventSubscriptions(
    source, classifications, symbols, symbolCalls,
  );
  const allCalls = mergedOutboundCalls(outboundCalls, events.classifications);
  const identities = reconcileBindingAndCallIdentity(
    source, bindings, allCalls, events.symbols,
  );
  return {
    bindings: identities.bindings,
    outboundCalls: identities.calls,
    symbols: events.symbols,
    symbolCalls: reconcileSymbolCallOwners(events.calls, events.symbols),
    classifications: events.classifications,
  };
}
