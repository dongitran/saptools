import ts from 'typescript';
import type { OutboundCallFact, ServiceBindingFact } from '../types.js';
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
  foldedConstants?: StaticStringConstant[];
  packageImportReference?: SymbolImportReference;
}

const CAP_CRUD_EVENTS = new Set(['READ', 'CREATE', 'UPDATE', 'DELETE']);
const KNOWN_NON_CAP_EVENT_RECEIVERS = new Set([
  'io', 'socket', 'realtime', 'writeStream', 'file', 'win', 'app',
  'desktopApp', 'windowRef',
]);

function eventNameReason(
  resolved: ExpressionResolution,
): string | undefined {
  if (resolved.status === 'static') return undefined;
  return resolved.value !== undefined && resolved.placeholderKeys.length > 0
    ? 'dynamic_event_name_identifier'
    : 'dynamic_event_name_unsupported_expression';
}

function stringConstantLookup(
  expression: ts.Expression,
  context: EventCallAnalysisContext,
): ImportedEventNameResult | StaticStringLookupResult {
  const local = resolveStringConstant(expression, context.constants);
  return local.status === 'not_found'
    ? context.importedConstant?.(expression) ?? local : local;
}

function foldedTemplateState(
  expression: ts.TemplateExpression,
  context: EventCallAnalysisContext,
): EventNameState | undefined {
  let eventName = expression.head.text;
  const placeholderKeys: string[] = [];
  const constants: StaticStringConstant[] = [];
  for (const span of expression.templateSpans) {
    const key = span.expression.getText(expression.getSourceFile()).trim();
    const lookup = stringConstantLookup(span.expression, context);
    if (lookup.status === 'resolved') {
      eventName += lookup.constant.value;
      constants.push(lookup.constant);
    } else {
      eventName += `\${${key}}`;
      placeholderKeys.push(key);
    }
    eventName += span.literal.text;
  }
  if (constants.length === 0) return undefined;
  const empty = eventName.length === 0;
  return {
    eventName: empty ? expression.getText(expression.getSourceFile()) : eventName,
    resolved: {
      status: empty ? 'dynamic'
        : placeholderKeys.length > 0 ? 'dynamic' : 'static',
      sourceKind: 'template_with_substitutions',
      value: empty ? undefined : eventName,
      rawExpression: expression.getText(expression.getSourceFile()),
      placeholderKeys,
      evidence: ['event_name_template_static_holes_folded'],
    },
    unresolvedReason: empty
      ? 'event_name_constant_value_empty'
      : placeholderKeys.length > 0
        ? 'dynamic_event_name_identifier' : undefined,
    foldedConstants: constants,
  };
}

function resolvedConstantState(
  expression: ts.Expression,
  constant: StaticStringConstant,
): EventNameState {
  const empty = constant.value.length === 0;
  return {
    eventName: empty ? expression.getText(expression.getSourceFile())
      : constant.value,
    resolved: {
      status: empty ? 'dynamic' : 'static',
      sourceKind: constant.kind,
      value: empty ? undefined : constant.value,
      rawExpression: expression.getText(expression.getSourceFile()),
      placeholderKeys: [],
      evidence: [`event_name_${constant.kind}`],
    },
    unresolvedReason: empty ? 'event_name_constant_value_empty' : undefined,
    constant,
  };
}

function refusedConstantState(
  expression: ts.Expression,
  lookup: ImportedEventNameResult | StaticStringLookupResult,
): EventNameState | undefined {
  if (lookup.status !== 'refused') return undefined;
  const raw = expression.getText(expression.getSourceFile());
  return {
    eventName: raw,
    resolved: {
      status: 'dynamic',
      sourceKind: 'dynamic_expression',
      rawExpression: raw,
      placeholderKeys: [],
      evidence: [lookup.reason],
    },
    unresolvedReason: lookup.reason,
    packageImportReference: packageReference(lookup),
  };
}

function eventNameState(
  node: ts.CallExpression,
  context: EventCallAnalysisContext,
): EventNameState | undefined {
  const expression = node.arguments[0];
  if (expression) {
    if (ts.isTemplateExpression(expression)) {
      const folded = foldedTemplateState(expression, context);
      if (folded) return folded;
    }
    const lookup = stringConstantLookup(expression, context);
    if (lookup.status === 'resolved')
      return resolvedConstantState(expression, lookup.constant);
    const refused = refusedConstantState(expression, lookup);
    if (refused) return refused;
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
  return method === 'on'
    && (state.eventName === 'error'
      || (CAP_CRUD_EVENTS.has(state.eventName)
        && capCrudReceiver(receiver)));
}

function capCrudReceiver(receiver: EventReceiverProof): boolean {
  const name = receiver.rootReceiver ?? receiver.effectiveReceiver;
  return name === 'this'
    || ['cds', 'srv', 'service', 'serviceClient'].includes(name);
}

function receiverRootName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)
    || ts.isElementAccessExpression(expression))
    return receiverRootName(expression.expression);
  if (ts.isCallExpression(expression))
    return receiverRootName(expression.expression);
  return undefined;
}

function pipeReceiver(expression: ts.Expression): boolean {
  return ts.isCallExpression(expression)
    && ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.name.text === 'pipe';
}

function knownNonCapReceiver(
  expression: ts.Expression,
  receiver: EventReceiverProof,
): boolean {
  if (receiver.receiverClassification !== 'unproven') return false;
  const root = receiverRootName(expression);
  return Boolean(root && KNOWN_NON_CAP_EVENT_RECEIVERS.has(root))
    || pipeReceiver(expression);
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
    receiverUnresolvedReason: receiver.unresolvedReason,
    receiverFallbackRefusedReason: receiver.fallbackRefusedReason,
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
    ...(state.foldedConstants ? {
      eventNameTemplateFoldedConstants: state.foldedConstants.slice(0, 8)
        .map((constant) => ({
          sourceKind: constant.kind,
          sourceFile: constant.sourceFile,
          declarationStartOffset: constant.declarationStartOffset,
          declarationEndOffset: constant.declarationEndOffset,
        })),
      eventNameTemplateFoldedConstantCount: state.foldedConstants.length,
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
  importedConstant?: ImportedEventNameResolver,
  environmentReference?: EventEnvironmentReferenceResolver,
  serviceBindings: readonly ServiceBindingFact[] = [],
): EventCallAnalysisContext {
  return {
    source,
    receivers: createEventReceiverIndex(source, serviceBindings),
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
  if (!expression) return undefined;
  if (!ts.isTemplateExpression(expression))
    return eventName.includes('${')
      ? deriveEventSkeleton(eventName) : undefined;
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
  if (receiver.unresolvedReason === 'event_receiver_not_cap_client'
    || knownNonCapReceiver(expression.expression, receiver))
    return { status: 'excluded' };
  if (excludedEvent(method, receiver, state)) return { status: 'excluded' };
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
      unresolvedReason: state.unresolvedReason,
    },
    evidence: eventEvidence(method, receiver, state),
  };
}
