import ts from 'typescript';
import type {
  LexicalScopeFact,
  ServiceBindingFact,
} from '../types.js';
import {
  createBindingLexicalIndex,
  declarationAt,
  lexicalScopeChain,
  sameScope,
  type BindingLexicalIndex,
  type BindingLexicalSite,
} from './binding-lexical-scope.js';
import {
  collectSymbolImportBindings,
  lexicalIdentifierDeclaration,
  type SymbolImportBinding,
} from './symbol-import-bindings.js';
import { stableLocalValueReference } from './stable-local-value.js';

export type EventReceiverUnresolvedReason =
  | 'event_receiver_unproven_binding'
  | 'event_receiver_unproven_propagation'
  | 'event_receiver_not_cap_client';

export interface EventReceiverEvidenceSite {
  startOffset: number;
  endOffset: number;
  flow: BindingLexicalSite['flow'] | 'reference';
  connect: boolean;
}

export interface EventReceiverProof {
  effectiveReceiver: string;
  receiver?: string;
  rootReceiver?: string;
  receiverClassification: 'cap_evidence' | 'name_fallback' | 'unproven';
  receiverProof: string;
  unresolvedReason?: EventReceiverUnresolvedReason;
  fallbackRefusedReason?: string;
  consideredBindingSites: EventReceiverEvidenceSite[];
}

export interface EventReceiverIndex {
  source: ts.SourceFile;
  lexical: BindingLexicalIndex;
  imports: SymbolImportBinding[];
  serviceBindings: readonly ServiceBindingFact[];
}

const eventReceiverNames = new Set([
  'cds', 'srv', 'service', 'serviceClient', 'messaging', 'messageClient',
  'eventClient',
]);

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (ts.isAwaitExpression(expression)
    || ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression))
    return unwrapExpression(expression.expression);
  return expression;
}

function capConnectCall(
  expression: ts.Expression,
): ts.CallExpression | undefined {
  const value = unwrapExpression(expression);
  if (!ts.isCallExpression(value)
    || !ts.isPropertyAccessExpression(value.expression)) return undefined;
  const callee = value.expression;
  if (callee.name.text === 'catch'
    && ts.isCallExpression(callee.expression))
    return capConnectCall(callee.expression);
  if (!['to', 'messaging'].includes(callee.name.text)
    || !ts.isPropertyAccessExpression(callee.expression)
    || callee.expression.name.text !== 'connect') return undefined;
  return ts.isIdentifier(callee.expression.expression) ? value : undefined;
}

function importedCdsRoot(
  call: ts.CallExpression,
  bindings: readonly SymbolImportBinding[],
): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)
    || !ts.isPropertyAccessExpression(callee.expression)
    || !ts.isIdentifier(callee.expression.expression)) return false;
  const root = callee.expression.expression;
  const declaration = lexicalIdentifierDeclaration(root);
  if (!declaration) return root.text === 'cds';
  const start = declaration.getStart(root.getSourceFile());
  const end = declaration.getEnd();
  const matches = bindings.filter((binding) =>
    binding.localName === root.text
    && binding.bindingSiteStartOffset === start
    && binding.bindingSiteEndOffset === end);
  return matches.length === 1
    && matches[0]?.rawModuleSpecifier === '@sap/cds';
}

function importedCdsIdentifier(
  identifier: ts.Identifier,
  index: EventReceiverIndex,
): boolean {
  const declaration = lexicalIdentifierDeclaration(identifier);
  if (!declaration) return false;
  const start = declaration.getStart(index.source);
  const end = declaration.getEnd();
  const matches = index.imports.filter((binding) =>
    binding.localName === identifier.text
    && binding.bindingSiteStartOffset === start
    && binding.bindingSiteEndOffset === end);
  return matches.length === 1
    && matches[0]?.rawModuleSpecifier === '@sap/cds';
}

function isCapConnect(
  expression: ts.Expression | undefined,
  bindings: readonly SymbolImportBinding[],
): boolean {
  if (!expression) return false;
  const call = capConnectCall(expression);
  return Boolean(call && importedCdsRoot(call, bindings));
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name)
    || ts.isNumericLiteral(name) ? name.text : undefined;
}

function objectSource(
  expression: ts.Expression | undefined,
): ts.ObjectLiteralExpression | undefined {
  if (!expression) return undefined;
  const value = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(value)) return value;
  if (!ts.isIdentifier(value)) return undefined;
  const binding = resolveLocalInitializer(value);
  return binding ? objectSource(binding) : undefined;
}

function resolveLocalInitializer(
  identifier: ts.Identifier,
): ts.Expression | undefined {
  const declaration = lexicalIdentifierDeclaration(identifier);
  if (!declaration || !ts.isVariableDeclaration(declaration.parent)
    || !stableLocalValueReference(identifier.getSourceFile(), declaration))
    return undefined;
  return declaration.parent.initializer;
}

function objectMember(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property)
      && propertyName(property.name) === name) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property)
      && property.name.text === name) return property.name;
  }
  return undefined;
}

function declarationBindingKey(
  declaration: ts.VariableDeclaration,
  variableName: string,
): string | undefined {
  if (!ts.isObjectBindingPattern(declaration.name)) return undefined;
  const match = declaration.name.elements.find((element) =>
    ts.isIdentifier(element.name) && element.name.text === variableName);
  if (!match) return undefined;
  return match.propertyName
    ? propertyName(match.propertyName) : variableName;
}

function assignmentBindingKey(
  node: ts.BinaryExpression,
  variableName: string,
): string | undefined {
  const left = unwrapExpression(node.left);
  if (!ts.isObjectLiteralExpression(left)) return undefined;
  for (const property of left.properties) {
    if (ts.isShorthandPropertyAssignment(property)
      && property.name.text === variableName) return variableName;
    if (ts.isPropertyAssignment(property)
      && ts.isIdentifier(property.initializer)
      && property.initializer.text === variableName)
      return propertyName(property.name);
  }
  return undefined;
}

function siteExpression(
  site: BindingLexicalSite,
  variableName: string,
): ts.Expression | undefined {
  if (ts.isVariableDeclaration(site.node)) {
    if (!ts.isIdentifier(site.node.name)) {
      const key = declarationBindingKey(site.node, variableName);
      const object = objectSource(site.node.initializer);
      return key && object ? objectMember(object, key) : undefined;
    }
    if (site.node.name.text !== variableName) return undefined;
    return site.node.initializer;
  }
  if (!ts.isBinaryExpression(site.node)
    || site.node.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
    return undefined;
  const key = assignmentBindingKey(site.node, variableName);
  const object = objectSource(site.node.right);
  return key && object ? objectMember(object, key) : site.node.right;
}

function sameExecutionScope(
  left: LexicalScopeFact,
  right: LexicalScopeFact,
): boolean {
  return sameScope(left, right);
}

function reachingSites(
  index: EventReceiverIndex,
  declaration: BindingLexicalSite,
  useStart: number,
): BindingLexicalSite[] {
  return index.lexical.sites.filter((site) =>
    site.declarationKey === declaration.declarationKey
    && site.startOffset < useStart
    && site.flow !== 'shadow'
    && sameExecutionScope(site.executionScope, declaration.executionScope));
}

function evidenceSites(
  sites: readonly BindingLexicalSite[],
  variableName: string,
  index: EventReceiverIndex,
): EventReceiverEvidenceSite[] {
  return sites.slice(0, 8).map((site) => ({
    startOffset: site.startOffset,
    endOffset: site.endOffset,
    flow: site.flow,
    connect: siteProvesCapClient(site, variableName, index),
  }));
}

function bindingMatchesSite(
  binding: ServiceBindingFact,
  site: BindingLexicalSite,
  variableName: string,
): boolean {
  return binding.variableName === variableName
    && binding.bindingSiteStartOffset === site.startOffset
    && binding.bindingSiteEndOffset === site.endOffset;
}

function siteServiceBinding(
  site: BindingLexicalSite,
  variableName: string,
  index: EventReceiverIndex,
): ServiceBindingFact | undefined {
  const matches = index.serviceBindings.filter((binding) =>
    bindingMatchesSite(binding, site, variableName));
  return matches.length === 1 ? matches[0] : undefined;
}

function siteProvesCapClient(
  site: BindingLexicalSite,
  variableName: string,
  index: EventReceiverIndex,
): boolean {
  return isCapConnect(siteExpression(site, variableName), index.imports)
    || siteServiceBinding(site, variableName, index) !== undefined;
}

function functionLikeValue(
  declaration: ts.Identifier,
): ts.FunctionLikeDeclaration | undefined {
  const parent = declaration.parent;
  if (ts.isFunctionDeclaration(parent)) return parent;
  if (!ts.isVariableDeclaration(parent) || !parent.initializer)
    return undefined;
  return ts.isArrowFunction(parent.initializer)
    || ts.isFunctionExpression(parent.initializer)
    ? parent.initializer : undefined;
}

function returnsObjectLiteral(
  fn: ts.FunctionLikeDeclaration,
): boolean {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body))
    return ts.isObjectLiteralExpression(unwrapExpression(fn.body));
  const returns: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    else ts.forEachChild(node, visit);
  };
  visit(fn);
  const expression = returns[0]?.expression;
  return returns.length === 1 && Boolean(
    expression && ts.isObjectLiteralExpression(unwrapExpression(expression)),
  );
}

function siteProvesNonCapClient(
  site: BindingLexicalSite,
  variableName: string,
): boolean {
  const expression = siteExpression(site, variableName);
  if (!expression) return false;
  const value = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(value)) return true;
  if (!ts.isCallExpression(value)
    || !ts.isIdentifier(value.expression)) return false;
  const declaration = lexicalIdentifierDeclaration(value.expression);
  const fn = declaration ? functionLikeValue(declaration) : undefined;
  return Boolean(fn && returnsObjectLiteral(fn));
}

function helperReturnProof(
  sites: readonly BindingLexicalSite[],
  variableName: string,
  index: EventReceiverIndex,
): boolean {
  return sites.some((site) => siteServiceBinding(
    site, variableName, index,
  )?.helperChain?.some((step) =>
    step.bindingOrigin === 'single_hop_helper_return'));
}

function lexicalProof(
  identifier: ts.Identifier,
  use: ts.Node,
  index: EventReceiverIndex,
): Omit<EventReceiverProof, 'effectiveReceiver' | 'receiver'
  | 'rootReceiver'> | undefined {
  const useStart = use.getStart(index.source);
  const selected = declarationAt(
    index.lexical.sites, identifier.text, useStart,
    lexicalScopeChain(use, index.source),
  );
  const declaration = selected.site;
  if (!declaration || selected.after || selected.ambiguous) return undefined;
  if (declaration.declarationKind === 'parameter')
    return unproven('event_receiver_unproven_propagation', 'parameter_flow');
  const sites = reachingSites(index, declaration, useStart);
  const valueSites = sites.filter((site) => {
    const value = siteExpression(site, identifier.text);
    return value !== undefined;
  });
  const considered = evidenceSites(sites, identifier.text, index);
  if (valueSites.length > 0
    && valueSites.every((site) =>
      siteProvesCapClient(site, identifier.text, index)))
    return {
      receiverClassification: 'cap_evidence',
      receiverProof: helperReturnProof(
        valueSites, identifier.text, index,
      ) ? 'single_hop_helper_return' : 'lexical_connect_assignment',
      consideredBindingSites: considered,
    };
  if (valueSites.length > 0
    && valueSites.every((site) =>
      siteProvesNonCapClient(site, identifier.text)))
    return unproven(
      'event_receiver_not_cap_client', 'non_connect_binding', considered,
    );
  return unproven(
    'event_receiver_unproven_binding', 'mixed_or_missing_assignment',
    considered,
  );
}

function unproven(
  reason: EventReceiverUnresolvedReason,
  proof: string,
  consideredBindingSites: EventReceiverEvidenceSite[] = [],
): Omit<EventReceiverProof, 'effectiveReceiver' | 'receiver'
  | 'rootReceiver'> {
  return {
    receiverClassification: 'unproven',
    receiverProof: proof,
    unresolvedReason: reason,
    consideredBindingSites,
  };
}

function compatibilityFallback(
  identifier: ts.Identifier,
  refusedReason: string,
  consideredBindingSites: EventReceiverEvidenceSite[],
): Omit<EventReceiverProof, 'effectiveReceiver' | 'receiver'
  | 'rootReceiver'> | undefined {
  return eventReceiverNames.has(identifier.text)
    ? {
        receiverClassification: 'name_fallback',
        receiverProof: 'compatibility_name_fallback',
        fallbackRefusedReason: refusedReason,
        consideredBindingSites: consideredBindingSites.length > 0
          ? consideredBindingSites
          : [{
              startOffset: identifier.getStart(identifier.getSourceFile()),
              endOffset: identifier.getEnd(),
              flow: 'reference',
              connect: false,
            }],
      }
    : undefined;
}

function identifierProof(
  identifier: ts.Identifier,
  use: ts.Node,
  index: EventReceiverIndex,
): Omit<EventReceiverProof, 'effectiveReceiver' | 'receiver'
  | 'rootReceiver'> {
  if (importedCdsIdentifier(identifier, index)) return {
    receiverClassification: 'cap_evidence',
    receiverProof: 'imported_cds_receiver',
    consideredBindingSites: [],
  };
  if (identifier.text === 'cds'
    && !lexicalIdentifierDeclaration(identifier)) return {
    receiverClassification: 'cap_evidence',
    receiverProof: 'global_cds_receiver',
    consideredBindingSites: [],
  };
  const proven = lexicalProof(identifier, use, index);
  return proven
    ?? compatibilityFallback(identifier, 'binding_not_found', [])
    ?? unproven('event_receiver_unproven_binding', 'binding_not_found');
}

function rootIdentifier(
  expression: ts.Expression,
): ts.Identifier | undefined {
  if (ts.isIdentifier(expression)) return expression;
  if (ts.isPropertyAccessExpression(expression)
    || ts.isElementAccessExpression(expression))
    return rootIdentifier(expression.expression);
  if (ts.isCallExpression(expression))
    return rootIdentifier(expression.expression);
  return undefined;
}

export function createEventReceiverIndex(
  source: ts.SourceFile,
  serviceBindings: readonly ServiceBindingFact[] = [],
): EventReceiverIndex {
  return {
    source,
    lexical: createBindingLexicalIndex(source),
    imports: collectSymbolImportBindings(source),
    serviceBindings,
  };
}

export function proveEventReceiver(
  expression: ts.Expression,
  use: ts.Node,
  index: EventReceiverIndex,
): EventReceiverProof {
  const receiver = expression.getText(index.source);
  if (ts.isIdentifier(expression)) {
    const proof = identifierProof(expression, use, index);
    return {
      ...proof, receiver, rootReceiver: expression.text,
      effectiveReceiver: expression.text,
    };
  }
  const root = rootIdentifier(expression);
  const rootProof = root ? identifierProof(root, use, index) : undefined;
  const nonCap = rootProof?.unresolvedReason === 'event_receiver_not_cap_client';
  const proof = nonCap
    ? unproven('event_receiver_not_cap_client', 'property_non_cap_root')
    : unproven(
        'event_receiver_unproven_propagation', 'property_receiver_propagation',
      );
  return {
    ...proof,
    receiver,
    rootReceiver: root?.text,
    effectiveReceiver: receiver,
  };
}
