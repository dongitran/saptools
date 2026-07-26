import ts from 'typescript';
import type {
  ExecutableSymbolFact,
  HandlerReferenceStatus,
  SymbolCallFact,
} from '../types.js';
import {
  collectSymbolImportBindings,
  symbolImportReference,
  type SymbolImportBinding,
  type SymbolImportReference,
} from './002-symbol-import-bindings.js';
import type { ClassifiedOutboundCall } from './outbound-call-parser.js';
import {
  localSymbolTarget,
  type LocalSymbolTargetIdentity,
} from './016-local-symbol-reference.js';

interface HandlerTarget {
  calleeExpression: string;
  calleeLocalName: string;
  importSource?: string;
  relation: string;
  referenceShape: string;
  wrapperFunction?: string;
  importBinding?: SymbolImportReference;
  localTargetIdentity?: LocalSymbolTargetIdentity;
}

interface HandlerClassification {
  status: HandlerReferenceStatus;
  reason?: string;
  referenceShape: string;
  target?: HandlerTarget;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function lineAt(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line + 1;
}

function importRelation(binding: SymbolImportReference): string {
  if (binding.moduleKind === 'package') return 'package_import';
  return binding.referenceShape === 'namespace_member'
    ? 'relative_import_namespace_member'
    : 'relative_import';
}

function directTarget(
  expression: ts.Expression,
  source: ts.SourceFile,
  imports: readonly SymbolImportBinding[],
  symbols: readonly ExecutableSymbolFact[],
): HandlerTarget | undefined {
  const imported = symbolImportReference(expression, imports);
  if (imported) return importedTarget(expression, source, imported);
  if (ts.isIdentifier(expression)) {
    const exact = localSymbolTarget(expression, source, symbols);
    return {
      calleeExpression: expression.text,
      calleeLocalName: expression.text,
      relation: exact
        ? 'indexed_local_symbol'
        : 'indexed_local_symbol_unproven',
      referenceShape: 'identifier',
      localTargetIdentity: exact,
    };
  }
  return propertyTarget(expression, source, symbols);
}

function importedTarget(
  expression: ts.Expression,
  source: ts.SourceFile,
  binding: SymbolImportReference,
): HandlerTarget {
  return {
    calleeExpression: expression.getText(source),
    calleeLocalName: binding.requestedPublicName,
    importSource: binding.rawModuleSpecifier,
    relation: importRelation(binding),
    referenceShape: binding.referenceShape,
    importBinding: binding,
  };
}

function propertyTarget(
  expression: ts.Expression,
  source: ts.SourceFile,
  symbols: readonly ExecutableSymbolFact[],
): HandlerTarget | undefined {
  if (!ts.isPropertyAccessExpression(expression) || expression.questionDotToken
    || !ts.isIdentifier(expression.expression)) return undefined;
  const exact = localSymbolTarget(expression, source, symbols);
  return {
    calleeExpression: expression.getText(source),
    calleeLocalName: `${expression.expression.text}.${expression.name.text}`,
    relation: exact
      ? 'indexed_local_symbol'
      : 'indexed_local_symbol_unproven',
    referenceShape: 'static_member',
    localTargetIdentity: exact,
  };
}

function unsupportedClassification(
  status: Exclude<HandlerReferenceStatus, 'role_required'>,
  reason: string,
  referenceShape: string,
): HandlerClassification {
  return { status, reason, referenceShape };
}

export function classifyHandlerReference(
  expression: ts.Expression | undefined,
  source: ts.SourceFile,
  imports = collectSymbolImportBindings(source),
  symbols: readonly ExecutableSymbolFact[] = [],
): HandlerClassification {
  if (!expression)
    return unsupportedClassification(
      'missing_argument', 'handler_argument_missing', 'missing',
    );
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))
    return unsupportedClassification(
      'unsupported_inline', 'inline_handler_body_not_indexed', 'inline_callback',
    );
  const direct = directTarget(expression, source, imports, symbols);
  if (direct)
    return { status: 'role_required', referenceShape: direct.referenceShape, target: direct };
  if (!ts.isCallExpression(expression))
    return unsupportedClassification(
      'unsupported_reference_shape', 'handler_reference_shape_unsupported',
      'unsupported_expression',
    );
  return classifyWrapperReference(expression, source, imports, symbols);
}

function classifyWrapperReference(
  expression: ts.CallExpression,
  source: ts.SourceFile,
  imports: readonly SymbolImportBinding[],
  symbols: readonly ExecutableSymbolFact[],
): HandlerClassification {
  if (expression.questionDotToken || expression.arguments.length !== 1)
    return unsupportedClassification(
      'unsupported_wrapper', 'wrapper_requires_one_reference', 'wrapper_call',
    );
  const inner = expression.arguments[0];
  const target = inner
    ? directTarget(inner, source, imports, symbols)
    : undefined;
  if (!target)
    return unsupportedClassification(
      'unsupported_wrapper', 'wrapper_reference_shape_unsupported', 'wrapper_call',
    );
  return {
    status: 'role_required',
    referenceShape: `wrapped_${target.referenceShape}`,
    target: { ...target, wrapperFunction: expression.expression.getText(source) },
  };
}

function eventSymbol(
  source: ts.SourceFile,
  classified: ClassifiedOutboundCall,
): ExecutableSymbolFact {
  const node = classified.node;
  const eventName = classified.fact.eventNameExpr ?? '';
  const line = lineOf(source, node);
  const safeName = eventName.replace(/[^A-Za-z0-9_$-]/g, '_');
  const name = `event:${safeName}:${line}`;
  const receiver = classified.fact.evidence?.receiver;
  return {
    kind: 'event_registration',
    localName: name,
    qualifiedName: `module:${classified.fact.sourceFile}#${name}`,
    sourceFile: classified.fact.sourceFile,
    startLine: line,
    endLine: lineAt(source, node.getEnd() - 1),
    startOffset: node.getStart(source),
    endOffset: node.getEnd(),
    exported: false,
    importExportEvidence: {
      source: 'synthetic_event_registration',
      eventName,
      registrationLine: line,
      receiver: typeof receiver === 'string' ? receiver : undefined,
    },
  };
}

function eventCall(
  classified: ClassifiedOutboundCall,
  owner: ExecutableSymbolFact,
  classification: HandlerClassification,
): SymbolCallFact | undefined {
  const target = classification.target;
  if (!target) return undefined;
  return {
    callerQualifiedName: owner.qualifiedName,
    calleeExpression: target.calleeExpression,
    calleeLocalName: target.calleeLocalName,
    importSource: target.importSource,
    sourceFile: classified.fact.sourceFile,
    sourceLine: classified.fact.sourceLine,
    callSiteStartOffset: classified.fact.callSiteStartOffset,
    callSiteEndOffset: classified.fact.callSiteEndOffset,
    callRole: 'event_subscribe_handler',
    evidence: {
      relation: target.relation,
      caller: owner.qualifiedName,
      targetName: target.calleeLocalName,
      referenceShape: classification.referenceShape,
      ...(target.importBinding ? { importBinding: target.importBinding } : {}),
      ...(target.localTargetIdentity
        ? { localTargetIdentity: target.localTargetIdentity }
        : {}),
      ...(target.wrapperFunction ? { wrapperFunction: target.wrapperFunction } : {}),
      factOrigin: 'event_subscribe_handler_reference',
    },
  };
}

function enrichSubscription(
  source: ts.SourceFile,
  classified: ClassifiedOutboundCall,
  symbols: readonly ExecutableSymbolFact[],
): { classified: ClassifiedOutboundCall; classification: HandlerClassification } {
  const classification = classifyHandlerReference(
    classified.node.arguments[1], source, undefined, symbols,
  );
  const evidence = {
    ...(classified.fact.evidence ?? {}),
    handlerReferenceStatus: classification.status,
    ...(classification.reason
      ? { handlerReferenceReason: classification.reason }
      : {}),
    handlerReferenceShape: classification.referenceShape,
  };
  return {
    classified: { ...classified, fact: { ...classified.fact, evidence } },
    classification,
  };
}

export function reconcileEventSubscriptions(
  source: ts.SourceFile,
  classifications: readonly ClassifiedOutboundCall[],
  symbols: readonly ExecutableSymbolFact[],
  calls: readonly SymbolCallFact[],
): {
  classifications: ClassifiedOutboundCall[];
  symbols: ExecutableSymbolFact[];
  calls: SymbolCallFact[];
} {
  const subscriptions = classifications.filter(
    (item) => item.fact.callType === 'async_subscribe',
  ).map((item) => enrichSubscription(source, item, symbols));
  const eventSymbols = subscriptions.map((item) => eventSymbol(source, item.classified));
  const eventCalls = subscriptions.flatMap((item, index) => {
    const owner = eventSymbols[index];
    const call = owner
      ? eventCall(item.classified, owner, item.classification)
      : undefined;
    return call ? [call] : [];
  });
  return {
    classifications: classifications.map((item) =>
      subscriptions.find((candidate) => candidate.classified.node === item.node)
        ?.classified ?? item),
    symbols: [...symbols.filter((item) => item.kind !== 'event_registration'), ...eventSymbols],
    calls: [
      ...calls.filter((item) => item.callRole !== 'event_subscribe_handler'),
      ...eventCalls,
    ],
  };
}
