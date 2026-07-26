import ts from 'typescript';
import type { LexicalScopeFact } from '../types.js';
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
  flow: BindingLexicalSite['flow'];
  connect: boolean;
}

export interface EventReceiverProof {
  effectiveReceiver: string;
  receiver?: string;
  rootReceiver?: string;
  receiverClassification: 'cap_evidence' | 'name_fallback' | 'unproven';
  receiverProof: string;
  unresolvedReason?: EventReceiverUnresolvedReason;
  consideredBindingSites: EventReceiverEvidenceSite[];
}

export interface EventReceiverIndex {
  source: ts.SourceFile;
  lexical: BindingLexicalIndex;
  imports: SymbolImportBinding[];
  compatibilityNames: Set<string>;
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

function unsupportedBranch(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current) && !ts.isFunctionLike(current)) {
    if (ts.isIfStatement(current) || ts.isConditionalExpression(current)
      || ts.isSwitchStatement(current)
      || ts.isIterationStatement(current, false)) return true;
    current = current.parent;
  }
  return false;
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
  bindings: readonly SymbolImportBinding[],
): EventReceiverEvidenceSite[] {
  return sites.slice(0, 8).map((site) => ({
    startOffset: site.startOffset,
    endOffset: site.endOffset,
    flow: site.flow,
    connect: isCapConnect(siteExpression(site, variableName), bindings),
  }));
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
  const expressions = sites.flatMap((site) => {
    const value = siteExpression(site, identifier.text);
    return value ? [value] : [];
  });
  const considered = evidenceSites(sites, identifier.text, index.imports);
  if (sites.some((site) => unsupportedBranch(site.node)))
    return unproven(
      'event_receiver_unproven_binding', 'branch_dependent_assignment',
      considered,
    );
  if (expressions.length > 0
    && expressions.every((value) => isCapConnect(value, index.imports)))
    return {
      receiverClassification: 'cap_evidence',
      receiverProof: 'lexical_connect_assignment',
      consideredBindingSites: considered,
    };
  if (expressions.some(Boolean)
    && expressions.every((value) => !isCapConnect(value, index.imports)))
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
  name: string,
  index: EventReceiverIndex,
): Omit<EventReceiverProof, 'effectiveReceiver' | 'receiver'
  | 'rootReceiver'> | undefined {
  return eventReceiverNames.has(name) || index.compatibilityNames.has(name)
    ? {
        receiverClassification: 'name_fallback',
        receiverProof: 'compatibility_name_fallback',
        consideredBindingSites: [],
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
  if (proven?.receiverClassification === 'cap_evidence') return proven;
  return compatibilityFallback(identifier.text, index)
    ?? proven
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
  compatibilityNames: Set<string>,
): EventReceiverIndex {
  return {
    source,
    lexical: createBindingLexicalIndex(source),
    imports: collectSymbolImportBindings(source),
    compatibilityNames,
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
