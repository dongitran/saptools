import ts from 'typescript';
import type {
  ExecutableSymbolFact,
  SymbolCallFact,
} from '../types.js';
import {
  executableSymbolCandidates,
  selectCallOwner,
} from './fact-identity.js';
import {
  derivedMemberImportReference,
  identifierMatchesDeclaration,
  symbolImportReference,
  type SymbolImportBinding,
  type SymbolImportReference,
} from './symbol-import-bindings.js';
import {
  localSymbolTarget,
  type LocalSymbolTargetIdentity,
} from './local-symbol-reference.js';

export interface SymbolCallProxy {
  importSource: string;
  importBinding: SymbolImportReference;
  factory: string;
  variableName: string;
  declarationStartOffset: number;
  declarationEndOffset: number;
}

export interface SymbolClassInstance {
  className: string;
  importSource?: string;
  importBinding?: SymbolImportReference;
  propertyName?: string;
  declarationStartOffset: number;
  declarationEndOffset: number;
  containerStartOffset?: number;
  containerEndOffset?: number;
}

interface CalleeName {
  expression: string;
  local?: string;
  member?: string;
  receiver?: string;
}

interface CallCollection {
  source: ts.SourceFile;
  sourceFile: string;
  symbols: readonly ExecutableSymbolFact[];
  imports: ReadonlyMap<string, string>;
  importBindings: readonly SymbolImportBinding[];
  proxies: ReadonlyMap<string, readonly SymbolCallProxy[]>;
  instances: ReadonlyMap<string, readonly SymbolClassInstance[]>;
}

interface CallContext {
  proxy?: SymbolCallProxy;
  instance?: SymbolClassInstance;
  reference?: SymbolImportReference;
  localTarget?: LocalSymbolTargetIdentity;
}

const commonTerminalMembers = new Set([
  'push', 'includes', 'find', 'findIndex', 'map', 'filter', 'reduce',
  'forEach', 'some', 'every', 'toUpperCase', 'toLowerCase', 'trim',
  'split', 'join', 'get', 'set', 'has',
]);
const loggerMembers = new Set([
  'trace', 'debug', 'info', 'warn', 'error', 'fatal', 'log',
]);
const globalObjects = new Set([
  'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'Date',
  'Promise', 'Reflect',
]);
const capDslRoots = new Set([
  'SELECT', 'INSERT', 'UPSERT', 'UPDATE', 'DELETE',
]);
const requestHelpers = new Set([
  'reject', 'error', 'info', 'warn', 'notify',
]);
const transportMembers = new Set([
  'emit', 'publish', 'send', 'on',
]);
const cdsFrameworkPrefixes = [
  'cds.connect.', 'cds.services.', 'cds.parse.',
];

export function symbolCallName(expr: ts.Expression): CalleeName {
  if (ts.isIdentifier(expr)) return { expression: expr.text, local: expr.text };
  if (!ts.isPropertyAccessExpression(expr))
    return { expression: expr.getText() };
  const left = expr.expression.getText();
  return {
    expression: expr.getText(),
    local: left === 'this' ? undefined : left.split('.')[0],
    member: expr.name.text,
    receiver: left,
  };
}

function hasSetMember(
  value: string | undefined,
  values: ReadonlySet<string>,
): boolean {
  return value ? values.has(value) : false;
}

function cdsFrameworkCall(callee: CalleeName): boolean {
  return callee.expression === 'cds.run'
    || cdsFrameworkPrefixes.some((prefix) =>
      callee.expression.startsWith(prefix));
}

function requestHelperCall(callee: CalleeName): boolean {
  return callee.local === 'req'
    && hasSetMember(callee.member, requestHelpers);
}

function ignoredFrameworkCall(callee: CalleeName): boolean {
  const checks = [
    hasSetMember(callee.local, capDslRoots),
    cdsFrameworkCall(callee),
    requestHelperCall(callee),
    hasSetMember(callee.member, transportMembers),
    hasSetMember(callee.local, globalObjects),
    callee.expression.startsWith('new Date().'),
  ];
  return checks.some(Boolean);
}

function argumentEvidence(
  args: ts.NodeArray<ts.Expression>,
): Array<Record<string, unknown>> {
  return args.map((arg) => {
    if (ts.isIdentifier(arg)) return { kind: 'identifier', name: arg.text };
    if (ts.isArrayLiteralExpression(arg)) return {
      kind: 'array_literal',
      elements: arg.elements.flatMap((item, index) =>
        ts.isIdentifier(item)
          ? [{ index, kind: 'identifier', name: item.text }]
          : []),
    };
    if (ts.isObjectLiteralExpression(arg))
      return objectArgumentEvidence(arg);
    return { kind: 'unsupported', expression: arg.getText() };
  });
}

function objectArgumentEvidence(
  argument: ts.ObjectLiteralExpression,
): Record<string, unknown> {
  const properties = argument.properties.flatMap((property) => {
    if (ts.isShorthandPropertyAssignment(property))
      return [{
        kind: 'shorthand',
        property: property.name.text,
        argument: property.name.text,
      }];
    if (!ts.isPropertyAssignment(property)
      || !ts.isIdentifier(property.initializer)) return [];
    const name = propertyName(property.name);
    return name ? [{
      kind: 'property_assignment',
      property: name,
      argument: property.initializer.text,
    }] : [];
  });
  return { kind: 'object_literal', properties };
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name)
    || ts.isNumericLiteral(name) ? name.text : undefined;
}

function exactCaller(
  collection: CallCollection,
  node: ts.CallExpression,
): ExecutableSymbolFact | undefined {
  const selected = selectCallOwner(
    executableSymbolCandidates(collection.symbols, collection.sourceFile),
    node.getStart(collection.source),
    node.getEnd(),
  );
  if (selected.status === 'ambiguous')
    throw new Error('invalid_prepared_repository_snapshot:symbol_call_owner_ambiguous');
  return selected.owner;
}

function relation(
  reference: SymbolImportReference | undefined,
  instance: SymbolClassInstance | undefined,
  proxy: SymbolCallProxy | undefined,
  localTarget: LocalSymbolTargetIdentity | undefined,
  provenThisMethod: boolean,
): string {
  const derived = derivedRelation(instance, proxy);
  if (derived) return derived;
  if (reference?.moduleKind === 'package') return 'package_import';
  if (reference?.referenceShape === 'namespace_member')
    return 'relative_import_namespace_member';
  if (reference) return 'relative_import';
  if (localTarget) return 'indexed_local_symbol';
  return provenThisMethod ? 'indexed_this_method' : 'indexed_local_symbol';
}

function derivedRelation(
  instance: SymbolClassInstance | undefined,
  proxy: SymbolCallProxy | undefined,
): string | undefined {
  if (instance?.importBinding?.moduleKind === 'package')
    return 'package_import_derived_member';
  if (instance) return 'class_instance_method';
  if (proxy?.importBinding.moduleKind === 'package')
    return 'package_import_derived_member';
  return proxy ? 'relative_import_proxy_member' : undefined;
}

function targetName(
  callee: CalleeName,
  reference: SymbolImportReference | undefined,
  instance: SymbolClassInstance | undefined,
  proxy: SymbolCallProxy | undefined,
): string | undefined {
  if (instance && callee.member)
    return `${instance.className}.${callee.member}`;
  if (proxy && callee.member) return callee.member;
  if (callee.receiver === 'this') return callee.member;
  if (reference) return reference.requestedPublicName;
  return callee.member && callee.local
    ? `${callee.local}.${callee.member}`
    : callee.local;
}

function callFact(
  collection: CallCollection,
  node: ts.CallExpression,
): SymbolCallFact | undefined {
  const caller = exactCaller(collection, node);
  if (!caller) return undefined;
  const callee = symbolCallName(node.expression);
  const proxy = callProxy(collection, node);
  const instance = callInstance(collection, node, callee);
  const reference = callImportReference(
    collection, node.expression, callee, instance, proxy,
  );
  const localTarget = reference || instance || proxy
    ? undefined
    : localSymbolTarget(node.expression, collection.source, collection.symbols);
  return retainedCallFact(collection, node, caller, callee, {
    proxy, instance, reference, localTarget,
  });
}

function expressionRoot(
  expression: ts.Expression,
): ts.Identifier | undefined {
  let current = expression;
  while (ts.isPropertyAccessExpression(current))
    current = current.expression;
  return ts.isIdentifier(current) ? current : undefined;
}

function exactDeclaredContext<T extends {
  declarationStartOffset: number;
  declarationEndOffset: number;
}>(
  identifier: ts.Identifier,
  candidates: readonly T[],
): T | undefined {
  const matches = candidates.filter((candidate) =>
    identifierMatchesDeclaration(
      identifier,
      candidate.declarationStartOffset,
      candidate.declarationEndOffset,
    ));
  return matches.length === 1 ? matches[0] : undefined;
}

function callProxy(
  collection: CallCollection,
  node: ts.CallExpression,
): SymbolCallProxy | undefined {
  const root = expressionRoot(node.expression);
  if (!root) return undefined;
  return exactDeclaredContext(
    root, collection.proxies.get(root.text) ?? [],
  );
}

function callInstance(
  collection: CallCollection,
  node: ts.CallExpression,
  callee: CalleeName,
): SymbolClassInstance | undefined {
  const root = expressionRoot(node.expression);
  if (root && root.text !== 'this') {
    const exact = exactDeclaredContext(
      root, collection.instances.get(root.text) ?? [],
    );
    if (exact) return exact;
  }
  return callee.receiver
    ? thisPropertyInstance(collection, node, callee.receiver)
    : undefined;
}

function enclosingClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isClassLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function thisPropertyInstance(
  collection: CallCollection,
  node: ts.CallExpression,
  receiver: string,
): SymbolClassInstance | undefined {
  if (!receiver.startsWith('this.')) return undefined;
  const container = enclosingClass(node);
  if (!container) return undefined;
  const start = container.getStart(collection.source);
  const end = container.getEnd();
  const matches = (collection.instances.get(receiver) ?? []).filter(
    (candidate) => candidate.containerStartOffset === start
      && candidate.containerEndOffset === end,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function callImportReference(
  collection: CallCollection,
  expression: ts.Expression,
  callee: CalleeName,
  instance: SymbolClassInstance | undefined,
  proxy: SymbolCallProxy | undefined,
): SymbolImportReference | undefined {
  const direct = symbolImportReference(expression, collection.importBindings);
  if (direct || !callee.member) return direct;
  const inherited = instance?.importBinding ?? proxy?.importBinding;
  return inherited
    ? derivedMemberImportReference(inherited, callee.member)
    : undefined;
}

function retainedCallFact(
  collection: CallCollection,
  node: ts.CallExpression,
  caller: ExecutableSymbolFact,
  callee: CalleeName,
  context: CallContext,
): SymbolCallFact | undefined {
  const target = targetName(
    callee, context.reference, context.instance, context.proxy,
  );
  const className = caller.qualifiedName.includes('.')
    ? caller.qualifiedName.split('.')[0] : undefined;
  const thisTarget = callee.receiver === 'this' && className && callee.member
    ? `${className}.${callee.member}` : undefined;
  const resolvedTarget = thisTarget ?? target;
  if (!resolvedTarget
    || !shouldRetainCall(
      collection, callee, resolvedTarget, context, Boolean(thisTarget),
    ))
    return undefined;
  return createCallFact(
    collection, node, caller, callee, resolvedTarget, thisTarget, context,
  );
}

function shouldRetainCall(
  collection: CallCollection,
  callee: CalleeName,
  target: string | undefined,
  context: CallContext,
  provenThisMethod: boolean,
): boolean {
  if (!target || ignoredCall(callee)) return false;
  const callables = new Set(collection.symbols.flatMap((symbol) =>
    [symbol.localName, symbol.qualifiedName]));
  return provenThisMethod
    || Boolean(context.localTarget)
    || callables.has(target) && Boolean(context.instance)
    || hasImportedContext(context);
}

function ignoredCall(callee: CalleeName): boolean {
  return loggerCall(callee) || terminalCall(callee)
    || ignoredFrameworkCall(callee);
}

function loggerCall(callee: CalleeName): boolean {
  if (callee.local === 'logger') return true;
  if (callee.receiver?.endsWith('.logger')) return true;
  return callee.expression.startsWith('this.logger.')
    && hasSetMember(callee.member, loggerMembers);
}

function terminalCall(callee: CalleeName): boolean {
  return hasSetMember(callee.member, commonTerminalMembers)
    || hasSetMember(callee.member, loggerMembers);
}

function hasImportedContext(context: CallContext): boolean {
  return Boolean(context.reference ?? context.proxy ?? context.instance);
}

function createCallFact(
  collection: CallCollection,
  node: ts.CallExpression,
  caller: ExecutableSymbolFact,
  callee: CalleeName,
  target: string,
  thisTarget: string | undefined,
  context: CallContext,
): SymbolCallFact {
  const importSource = context.instance?.importSource
    ?? context.proxy?.importSource
    ?? context.reference?.rawModuleSpecifier;
  return {
    callerQualifiedName: caller.qualifiedName,
    calleeExpression: callee.expression,
    calleeLocalName: target,
    receiverLocalName: callee.member ? callee.local ?? callee.receiver : undefined,
    importSource,
    sourceFile: collection.sourceFile,
    sourceLine: collection.source.getLineAndCharacterOfPosition(
      node.getStart(collection.source),
    ).line + 1,
    callSiteStartOffset: node.getStart(collection.source),
    callSiteEndOffset: node.getEnd(),
    callRole: 'ordinary_call',
    evidence: callEvidence(caller, callee, target, thisTarget, context, node),
  };
}

function callEvidence(
  caller: ExecutableSymbolFact,
  callee: CalleeName,
  target: string,
  thisTarget: string | undefined,
  context: CallContext,
  node: ts.CallExpression,
): Record<string, unknown> {
  return {
    relation: relation(
      context.reference, context.instance, context.proxy,
      context.localTarget, Boolean(thisTarget),
    ),
    caller: caller.qualifiedName,
    targetName: target,
    ...importReferenceEvidence(context),
    ...instanceEvidence(context.instance, callee),
    callArguments: argumentEvidence(node.arguments),
    ...proxyEvidence(context.proxy),
    ...(context.localTarget
      ? { localTargetIdentity: context.localTarget }
      : {}),
    candidateStrategy: parserCandidateStrategy(context),
  };
}

function importReferenceEvidence(
  context: CallContext,
): Record<string, unknown> {
  if (!context.reference) return {};
  const derived = context.instance ?? context.proxy;
  return derived && context.reference.moduleKind === 'package'
    ? { derivedImportBinding: context.reference }
    : { importBinding: context.reference };
}

function instanceEvidence(
  instance: SymbolClassInstance | undefined,
  callee: CalleeName,
): Record<string, unknown> {
  if (!instance) return {};
  return {
    instanceVariable: instance.propertyName ?? callee.local,
    className: instance.className,
    methodName: callee.member,
    classImportSource: instance.importSource,
    classImportBinding: instance.importBinding,
  };
}

function proxyEvidence(
  proxy: SymbolCallProxy | undefined,
): Record<string, unknown> {
  if (!proxy) return {};
  return {
    proxyVariableName: proxy.variableName,
    factory: proxy.factory,
    factoryExpression: proxy.factory,
    factoryImportSource: proxy.importSource,
    factoryImportBinding: proxy.importBinding,
  };
}

function parserCandidateStrategy(context: CallContext): string | undefined {
  if (context.instance?.importSource)
    return 'relative_import_class_instance_method';
  if (context.instance) return 'same_file_class_instance_method';
  return context.proxy
    ? 'proxy_member_exact_export_or_unique_member'
    : undefined;
}

export function collectSymbolCallFacts(
  collection: CallCollection,
): SymbolCallFact[] {
  const calls: SymbolCallFact[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const call = callFact(collection, node);
      if (call) calls.push(call);
    }
    ts.forEachChild(node, visit);
  };
  visit(collection.source);
  return calls;
}
