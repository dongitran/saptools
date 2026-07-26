import ts from 'typescript';
import type { OutboundCallFact } from '../types.js';
import {
  CDS_LIFECYCLE_EVENTS,
  resolveExpression,
  type ExpressionResolution,
} from './outbound-expression-analysis.js';
import {
  createEventReceiverIndex,
  proveEventReceiver,
  type EventReceiverIndex,
  type EventReceiverProof,
} from './event-receiver-analysis.js';
import {
  collectStringConstantLookups,
  resolveStringConstant,
  type StaticStringConstant,
  type StaticStringLookupResult,
  type StringConstantLookups,
} from './string-constant-lookups.js';
import type {
  ImportedEventNameResult,
  ImportedEventNameResolver,
} from './event-name-import-resolution.js';
import type {
  SymbolImportReference,
} from './symbol-import-bindings.js';
import {
  deriveEventSkeleton,
  type EventSkeletonFact,
} from '../utils/event-skeleton.js';
import type {
  EventEnvironmentReferenceResolver,
} from './event-environment-reference.js';

type EventFact = Pick<OutboundCallFact,
  'callType' | 'serviceVariableName' | 'eventNameExpr'
  | 'eventSkeleton' | 'confidence' | 'unresolvedReason'>;

export interface EventCallAnalysisContext {
  source: ts.SourceFile;
  receivers: EventReceiverIndex;
  constants: StringConstantLookups;
  importedConstant?: ImportedEventNameResolver;
  environmentReference?: EventEnvironmentReferenceResolver;
}

export type EventCallAnalysis =
  | { status: 'classified'; fact: EventFact; evidence: Record<string, unknown> }
  | { status: 'excluded' }
  | { status: 'unclassified' };

interface EventNameState {
  eventName: string;
  resolved: ExpressionResolution;
  unresolvedReason?: string;
  constant?: StaticStringConstant;
  packageImportReference?: SymbolImportReference;
}

function eventNameReason(
  resolved: ExpressionResolution,
): string | undefined {
  if (resolved.status === 'static') return undefined;
  return resolved.value !== undefined && resolved.placeholderKeys.length > 0
    ? 'dynamic_event_name_identifier'
    : 'dynamic_event_name_unsupported_expression';
}

function eventNameState(
  node: ts.CallExpression,
  context: EventCallAnalysisContext,
): EventNameState | undefined {
  const expression = node.arguments[0];
  if (expression) {
    const local = resolveStringConstant(expression, context.constants);
    const lookup = local.status === 'not_found'
      ? context.importedConstant?.(expression) ?? local
      : local;
    if (lookup.status === 'resolved') return {
      eventName: lookup.constant.value,
      resolved: {
        status: 'static',
        sourceKind: lookup.constant.kind,
        value: lookup.constant.value,
        rawExpression: expression.getText(node.getSourceFile()),
        placeholderKeys: [],
        evidence: [`event_name_${lookup.constant.kind}`],
      },
      constant: lookup.constant,
    };
    if (lookup.status === 'refused') return {
      eventName: expression.getText(node.getSourceFile()),
      resolved: {
        status: 'dynamic',
        sourceKind: 'dynamic_expression',
        rawExpression: expression.getText(node.getSourceFile()),
        placeholderKeys: [],
        evidence: [lookup.reason],
      },
      unresolvedReason: lookup.reason,
      packageImportReference: packageReference(lookup),
    };
  }
  const resolved = resolveExpression(expression, node, 'operation_path');
  const eventName = resolved.value
    ?? resolved.rawExpression
    ?? expression?.getText(node.getSourceFile());
  return eventName ? {
    eventName,
    resolved,
    unresolvedReason: eventNameReason(resolved),
  } : undefined;
}

function packageReference(
  value: ImportedEventNameResult | StaticStringLookupResult,
): SymbolImportReference | undefined {
  return 'packageImportReference' in value
    ? value.packageImportReference : undefined;
}

function eventConfidence(
  receiver: EventReceiverProof,
  eventReason: string | undefined,
): number {
  const receiverConfidence = receiver.receiverClassification === 'unproven'
    ? 0.2 : receiver.receiverClassification === 'name_fallback' ? 0.5 : 0.8;
  const nameConfidence = !eventReason
    ? 0.8 : eventReason === 'dynamic_event_name_identifier' ? 0.6 : 0.3;
  return Math.min(receiverConfidence, nameConfidence);
}

function excludedEvent(
  method: string,
  receiver: EventReceiverProof,
  state: EventNameState,
): boolean {
  if (state.resolved.status !== 'static') return false;
  if (receiver.effectiveReceiver === 'cds'
    && CDS_LIFECYCLE_EVENTS.has(state.eventName)) return true;
  return method === 'on' && state.eventName === 'error';
}

function eventEvidence(
  method: string,
  receiver: EventReceiverProof,
  state: EventNameState,
): Record<string, unknown> {
  return {
    receiver: receiver.receiver,
    rootReceiver: receiver.rootReceiver,
    classifier: method === 'on'
      ? 'cap_service_event_subscription' : 'cap_service_event_emit',
    receiverClassification: receiver.receiverClassification,
    receiverProof: receiver.receiverProof,
    consideredBindingSites: receiver.consideredBindingSites,
    eventNameUnresolvedReason: state.unresolvedReason,
    eventNameConstantImportBinding: state.packageImportReference,
    eventNameConstantSourceExpression: state.packageImportReference
      ? state.eventName : undefined,
    ...(state.constant ? {
      eventNameConstant: {
        sourceKind: state.constant.kind,
        sourceFile: state.constant.sourceFile,
        declarationStartOffset: state.constant.declarationStartOffset,
        declarationEndOffset: state.constant.declarationEndOffset,
      },
    } : {}),
    ...(state.resolved.status === 'static' ? {} : {
      eventNameStatus: state.resolved.status,
      eventNameSourceKind: state.resolved.sourceKind,
      eventNamePlaceholderKeys: state.resolved.placeholderKeys,
    }),
  };
}

export function createEventCallAnalysisContext(
  source: ts.SourceFile,
  compatibilityNames: Set<string>,
  importedConstant?: ImportedEventNameResolver,
  environmentReference?: EventEnvironmentReferenceResolver,
): EventCallAnalysisContext {
  return {
    source,
    receivers: createEventReceiverIndex(source, compatibilityNames),
    constants: collectStringConstantLookups(source),
    importedConstant,
    environmentReference,
  };
}

function eventSkeleton(
  node: ts.CallExpression,
  eventName: string,
  resolver: EventEnvironmentReferenceResolver | undefined,
): EventSkeletonFact | undefined {
  const expression = node.arguments[0];
  if (!expression || !ts.isTemplateExpression(expression)) return undefined;
  const skeleton = deriveEventSkeleton(eventName);
  if (!skeleton || !resolver) return skeleton;
  return {
    ...skeleton,
    environmentBindings: expression.templateSpans.flatMap((span) => {
      const reference = resolver(span.expression);
      return reference ? [{
        ...reference,
        sourceKey: span.expression.getText(node.getSourceFile()).trim(),
      }] : [];
    }),
  };
}

export function analyzeEventCall(
  node: ts.CallExpression,
  expression: ts.PropertyAccessExpression,
  context: EventCallAnalysisContext,
): EventCallAnalysis {
  const method = expression.name.text;
  const state = eventNameState(node, context);
  if (!state) return { status: 'unclassified' };
  const receiver = proveEventReceiver(
    expression.expression, node, context.receivers,
  );
  if (excludedEvent(method, receiver, state)) return { status: 'excluded' };
  const unresolvedReason = receiver.unresolvedReason
    ?? state.unresolvedReason;
  return {
    status: 'classified',
    fact: {
      callType: method === 'on' ? 'async_subscribe' : 'async_emit',
      serviceVariableName: receiver.effectiveReceiver,
      eventNameExpr: state.eventName,
      eventSkeleton: eventSkeleton(
        node, state.eventName, context.environmentReference,
      ),
      confidence: eventConfidence(receiver, state.unresolvedReason),
      unresolvedReason,
    },
    evidence: eventEvidence(method, receiver, state),
  };
}
