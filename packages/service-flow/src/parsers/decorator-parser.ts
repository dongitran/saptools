import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type {
  HandlerClassFact,
  HandlerLifecycleEvent,
  HandlerLifecyclePhase,
  HandlerMethodFact,
  HandlerMethodKind,
} from '../types.js';
import { generatedOperationNameFromConstant } from '../linker/operation-decorator-normalizer.js';
import {
  createSourceFile,
  type RepositorySourceContext,
} from './ts-project.js';
import { normalizePath } from '../utils/path-utils.js';

type DecoratorResolution = HandlerMethodFact['decoratorResolution'];
type ResolvedArgumentKind = Exclude<
  DecoratorResolution['resolutionKind'],
  'lifecycle_implicit' | 'unresolved'
>;
interface StringLookups {
  identifiers: Map<string, string>;
  enumMembers: Map<string, string>;
  objectProperties: Map<string, string>;
  capDecoratorNames: Map<string, string>;
  capDecoratorNamespaces: Set<string>;
}
interface LifecycleMetadata {
  phase: HandlerLifecyclePhase;
  event: HandlerLifecycleEvent;
}
interface MethodClassification {
  handlerKind: HandlerMethodKind;
  executable: boolean;
  lifecyclePhase?: HandlerLifecyclePhase;
  lifecycleEvent?: HandlerLifecycleEvent;
}
interface ParsedMethodDecorator {
  classification: MethodClassification;
  resolution: DecoratorResolution;
  decoratorKind: string;
  importedKind?: string;
}

const OPERATION_DECORATORS = new Set(['Action', 'Func', 'On']);
const EVENT_DECORATORS = new Set(['Event']);
const LIFECYCLE_DECORATORS = new Map<string, LifecycleMetadata>([
  ['BeforeCreate', { phase: 'before', event: 'CREATE' }],
  ['OnCreate', { phase: 'on', event: 'CREATE' }],
  ['AfterCreate', { phase: 'after', event: 'CREATE' }],
  ['BeforeRead', { phase: 'before', event: 'READ' }],
  ['OnRead', { phase: 'on', event: 'READ' }],
  ['AfterRead', { phase: 'after', event: 'READ' }],
  ['BeforeUpdate', { phase: 'before', event: 'UPDATE' }],
  ['OnUpdate', { phase: 'on', event: 'UPDATE' }],
  ['AfterUpdate', { phase: 'after', event: 'UPDATE' }],
  ['BeforeDelete', { phase: 'before', event: 'DELETE' }],
  ['OnDelete', { phase: 'on', event: 'DELETE' }],
  ['AfterDelete', { phase: 'after', event: 'DELETE' }],
]);

function line(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}
function decs(node: ts.Node): ts.Decorator[] {
  return ts.canHaveDecorators(node) ? [...(ts.getDecorators(node) ?? [])] : [];
}
function callName(d: ts.Decorator): string {
  const e = d.expression;
  return ts.isCallExpression(e) ? e.expression.getText() : e.getText();
}
function firstArg(d: ts.Decorator): ts.Expression | undefined {
  const e = d.expression;
  return ts.isCallExpression(e) ? e.arguments[0] : undefined;
}
function decoratorArguments(d: ts.Decorator): readonly ts.Expression[] | undefined {
  return ts.isCallExpression(d.expression) ? d.expression.arguments : undefined;
}
function methodName(name: ts.PropertyName): string {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name)
    || ts.isNumericLiteral(name)
    ? name.text
    : name.getText();
}
function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
  ) current = current.expression;
  return current;
}
function stringValue(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  const unwrapped = unwrapExpression(expression);
  return ts.isStringLiteralLike(unwrapped) ? unwrapped.text : undefined;
}
function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return undefined;
}
function collectEnumMembers(
  statement: ts.EnumDeclaration,
  lookups: StringLookups,
): void {
  for (const member of statement.members) {
    const name = propertyName(member.name);
    const value = stringValue(member.initializer);
    if (name && value !== undefined)
      lookups.enumMembers.set(`${statement.name.text}.${name}`, value);
  }
}
function collectObjectProperties(
  name: string,
  initializer: ts.Expression,
  lookups: StringLookups,
): void {
  const object = unwrapExpression(initializer);
  if (!ts.isObjectLiteralExpression(object)) return;
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = propertyName(property.name);
    const value = stringValue(property.initializer);
    if (key && value !== undefined)
      lookups.objectProperties.set(`${name}.${key}`, value);
  }
}
function collectStringLookups(source: ts.SourceFile): StringLookups {
  const lookups: StringLookups = {
    identifiers: new Map(),
    enumMembers: new Map(),
    objectProperties: new Map(),
    capDecoratorNames: new Map(),
    capDecoratorNamespaces: new Set(),
  };
  for (const statement of source.statements) {
    collectCapDecoratorImports(statement, lookups);
    if (ts.isEnumDeclaration(statement)) collectEnumMembers(statement, lookups);
    if (!ts.isVariableStatement(statement)
      || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const value = stringValue(declaration.initializer);
      if (value !== undefined) lookups.identifiers.set(declaration.name.text, value);
      collectObjectProperties(declaration.name.text, declaration.initializer, lookups);
    }
  }
  return lookups;
}
function collectCapDecoratorImports(
  statement: ts.Statement,
  lookups: StringLookups,
): void {
  if (!ts.isImportDeclaration(statement)
    || !ts.isStringLiteral(statement.moduleSpecifier)
    || statement.moduleSpecifier.text !== 'cds-routing-handlers') return;
  const clause = statement.importClause;
  if (!clause || clause.isTypeOnly) return;
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      lookups.capDecoratorNames.set(
        element.name.text,
        element.propertyName?.text ?? element.name.text,
      );
    }
  }
  if (bindings && ts.isNamespaceImport(bindings))
    lookups.capDecoratorNamespaces.add(bindings.name.text);
}
function capDecoratorName(
  decorator: ts.Decorator,
  lookups: StringLookups,
): string | undefined {
  const expression = ts.isCallExpression(decorator.expression)
    ? decorator.expression.expression
    : decorator.expression;
  if (ts.isIdentifier(expression))
    return lookups.capDecoratorNames.get(expression.text);
  if (ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && lookups.capDecoratorNamespaces.has(expression.expression.text))
    return expression.name.text;
  return undefined;
}
function unresolved(
  rawExpression: string,
  reason: string,
  argumentExpression?: string,
): DecoratorResolution {
  return {
    rawExpression,
    argumentExpression,
    resolutionKind: 'unresolved',
    unresolvedReason: reason,
  };
}
function resolved(
  rawExpression: string,
  argumentExpression: string,
  resolvedValue: string,
  resolutionKind: ResolvedArgumentKind,
): DecoratorResolution {
  return { rawExpression, argumentExpression, resolvedValue, resolutionKind };
}
function generatedConstant(rawExpression: string): string | undefined {
  const match = /(?:^|\.)(Action[A-Z][\w$]*|Func[A-Z][\w$]*)\.name$/
    .exec(rawExpression.trim());
  return match?.[1]
    ? generatedOperationNameFromConstant(match[1])
    : undefined;
}
function resolveDecoratorArgument(
  argument: ts.Expression | undefined,
  lookups: StringLookups,
  rawExpression: string,
): DecoratorResolution {
  if (!argument) return unresolved(rawExpression, 'decorator_argument_missing');
  const argumentExpression = argument.getText();
  const expression = unwrapExpression(argument);
  if (ts.isStringLiteralLike(expression))
    return resolved(rawExpression, argumentExpression, expression.text, 'literal');
  if (ts.isIdentifier(expression)) {
    const value = lookups.identifiers.get(expression.text);
    return value === undefined
      ? unresolved(rawExpression, 'identifier_not_resolved_to_local_const_string', argumentExpression)
      : resolved(rawExpression, argumentExpression, value, 'const_identifier');
  }
  if (ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)) {
    const key = `${expression.expression.text}.${expression.name.text}`;
    const enumValue = lookups.enumMembers.get(key);
    if (enumValue !== undefined)
      return resolved(rawExpression, argumentExpression, enumValue, 'enum_member');
    const objectValue = lookups.objectProperties.get(key);
    if (objectValue !== undefined)
      return resolved(rawExpression, argumentExpression, objectValue, 'const_object_property');
  }
  const generatedValue = generatedConstant(argumentExpression);
  if (generatedValue !== undefined)
    return resolved(
      rawExpression,
      argumentExpression,
      generatedValue,
      'generated_constant_name',
    );
  if (ts.isPropertyAccessExpression(expression))
    return unresolved(
      rawExpression,
      'property_access_not_resolved_to_local_string',
      argumentExpression,
    );
  return unresolved(rawExpression, 'unsupported_decorator_expression', argumentExpression);
}
function classificationFor(name: string): MethodClassification | undefined {
  if (OPERATION_DECORATORS.has(name))
    return { handlerKind: 'operation', executable: true };
  if (EVENT_DECORATORS.has(name))
    return { handlerKind: 'event', executable: true };
  const lifecycle = LIFECYCLE_DECORATORS.get(name);
  if (!lifecycle) return undefined;
  return {
    handlerKind: 'entity_lifecycle',
    executable: true,
    lifecyclePhase: lifecycle.phase,
    lifecycleEvent: lifecycle.event,
  };
}
function lifecycleLikePhase(name: string): HandlerLifecyclePhase | undefined {
  if (/^On[A-Z]/.test(name)) return 'on';
  if (/^Before[A-Z]/.test(name)) return 'before';
  if (/^After[A-Z]/.test(name)) return 'after';
  return undefined;
}
function withClassification(
  resolution: DecoratorResolution,
  classification: MethodClassification,
): DecoratorResolution {
  return {
    ...resolution,
    handlerKind: classification.handlerKind,
    executable: classification.executable,
    lifecyclePhase: classification.lifecyclePhase,
    lifecycleEvent: classification.lifecycleEvent,
  };
}
function withDecoratorEvidence(
  resolution: DecoratorResolution,
  decorator: ts.Decorator,
  resolvedDecoratorKind: string | undefined,
): DecoratorResolution {
  return {
    ...resolution,
    decoratorExpression: decorator.expression.getText(),
    resolvedDecoratorKind,
    decoratorImportSource: resolvedDecoratorKind
      ? 'cds-routing-handlers'
      : undefined,
  };
}
function lifecycleDecoratorResolution(
  decorator: ts.Decorator,
  lookups: StringLookups,
  classification: MethodClassification,
): { classification: MethodClassification; resolution: DecoratorResolution } {
  const rawExpression = decorator.expression.getText();
  const args = decoratorArguments(decorator);
  if (args?.length === 0)
    return {
      classification,
      resolution: withClassification({
        rawExpression,
        resolutionKind: 'lifecycle_implicit',
      }, classification),
    };
  const resolution = args?.length === 1
    ? resolveDecoratorArgument(args[0], lookups, rawExpression)
    : unresolved(rawExpression, args ? 'unsupported_lifecycle_argument_count' : 'lifecycle_decorator_call_required');
  const unsupported = { ...classification, handlerKind: 'unsupported_lifecycle', executable: false } as const;
  const unsupportedResolution = args?.length === 1
    ? { ...resolution, unresolvedReason: 'lifecycle_decorator_arguments_not_supported' }
    : resolution;
  return {
    classification: unsupported,
    resolution: withClassification(unsupportedResolution, unsupported),
  };
}
function unsupportedLifecycleResolution(
  decorator: ts.Decorator,
  phase: HandlerLifecyclePhase,
): { classification: MethodClassification; resolution: DecoratorResolution } {
  const classification: MethodClassification = {
    handlerKind: 'unsupported_lifecycle',
    executable: false,
    lifecyclePhase: phase,
  };
  const resolution = unresolved(
    decorator.expression.getText(),
    'lifecycle_decorator_not_allowlisted',
  );
  return { classification, resolution: withClassification(resolution, classification) };
}
function unsupportedDecoratorResolution(
  decorator: ts.Decorator,
  reason: string,
  phase?: HandlerLifecyclePhase,
): { classification: MethodClassification; resolution: DecoratorResolution } {
  const classification: MethodClassification = {
    handlerKind: phase ? 'unsupported_lifecycle' : 'unsupported_decorator',
    executable: false,
    lifecyclePhase: phase,
  };
  return {
    classification,
    resolution: withClassification(
      unresolved(decorator.expression.getText(), reason),
      classification,
    ),
  };
}
function parseMethodDecorator(
  decorator: ts.Decorator,
  lookups: StringLookups,
  handlerClass: boolean,
  allowLifecycle: boolean,
): ParsedMethodDecorator | undefined {
  const decoratorKind = callName(decorator);
  const importedKind = capDecoratorName(decorator, lookups);
  const resolvedKind = importedKind ?? decoratorKind;
  const base = classificationFor(resolvedKind);
  const phase = lifecycleLikePhase(resolvedKind);
  const isLifecycle = base?.handlerKind === 'entity_lifecycle' || Boolean(phase && !base);
  if (!handlerClass && isLifecycle) return undefined;
  const parsed = isLifecycle && (!allowLifecycle || !importedKind)
    ? unsupportedDecoratorResolution(
        decorator, 'lifecycle_decorator_import_not_supported', phase,
      )
    : base?.handlerKind === 'entity_lifecycle'
      ? lifecycleDecoratorResolution(decorator, lookups, base)
      : phase && !base
        ? unsupportedLifecycleResolution(decorator, phase)
        : !base && handlerClass
          ? unsupportedDecoratorResolution(decorator, 'decorator_not_allowlisted')
          : {
              classification: base,
              resolution: resolveDecoratorArgument(
                firstArg(decorator),
                lookups,
                firstArg(decorator)?.getText() ?? decorator.expression.getText(),
              ),
            };
  if (!parsed.classification) return undefined;
  return {
    classification: parsed.classification,
    resolution: parsed.resolution,
    decoratorKind,
    importedKind,
  };
}
function methodDecoratorFact(
  method: ts.MethodDeclaration,
  decorator: ts.Decorator,
  lookups: StringLookups,
  source: ts.SourceFile,
  filePath: string,
  handlerClass: boolean,
  allowLifecycle: boolean,
): HandlerMethodFact | undefined {
  const parsed = parseMethodDecorator(decorator, lookups, handlerClass, allowLifecycle);
  if (!parsed) return undefined;
  const classification = method.body
    ? parsed.classification
    : { ...parsed.classification, executable: false };
  const resolution = method.body
    ? parsed.resolution
    : { ...parsed.resolution, unresolvedReason: 'handler_method_body_missing' };
  const argumentExpression = firstArg(decorator)?.getText();
  return {
    methodName: methodName(method.name),
    decoratorKind: parsed.decoratorKind,
    decoratorValue: parsed.resolution.resolvedValue,
    decoratorRawExpression: argumentExpression ?? decorator.expression.getText(),
    handlerKind: classification.handlerKind,
    executable: classification.executable,
    lifecyclePhase: classification.lifecyclePhase,
    lifecycleEvent: classification.lifecycleEvent,
    decoratorResolution: withDecoratorEvidence(
      withClassification(resolution, classification),
      decorator,
      parsed.importedKind,
    ),
    sourceFile: normalizePath(filePath),
    sourceLine: line(source, method.getStart()),
  };
}
function unique(values: string[]): string[] {
  return [...new Set(values)];
}
function parseClassMethods(
  node: ts.ClassDeclaration,
  lookups: StringLookups,
  source: ts.SourceFile,
  filePath: string,
  handlerClass: boolean,
  allowLifecycle: boolean,
): Pick<HandlerClassFact, 'methods' | 'observedDecoratorNames' | 'unsupportedDecoratorNames'> {
  const methods: HandlerMethodFact[] = [];
  const observed: string[] = [];
  const unsupported: string[] = [];
  for (const method of node.members.filter(ts.isMethodDeclaration)) {
    for (const decorator of decs(method)) {
      observed.push(callName(decorator));
      const fact = methodDecoratorFact(
        method, decorator, lookups, source, filePath, handlerClass, allowLifecycle,
      );
      if (fact) methods.push(fact);
      if (!fact?.executable) unsupported.push(callName(decorator));
    }
  }
  return {
    methods,
    observedDecoratorNames: unique(observed),
    unsupportedDecoratorNames: unique(unsupported),
  };
}
function parseHandlerClass(
  node: ts.ClassDeclaration,
  lookups: StringLookups,
  source: ts.SourceFile,
  filePath: string,
): HandlerClassFact | undefined {
  const classDecoratorNames = unique(decs(node).map(callName));
  const classDecorators = decs(node);
  const hasImportedHandler = classDecorators.some((decorator) =>
    capDecoratorName(decorator, lookups) === 'Handler');
  const hasHandlerDecorator = hasImportedHandler
    || classDecoratorNames.includes('Handler');
  const parsed = parseClassMethods(
    node, lookups, source, filePath, hasHandlerDecorator, hasImportedHandler,
  );
  if (!hasHandlerDecorator && parsed.methods.length === 0) return undefined;
  return {
    className: node.name?.text ?? 'AnonymousHandler',
    sourceFile: normalizePath(filePath),
    sourceLine: line(source, node.getStart()),
    ...parsed,
    hasHandlerDecorator,
    classDecoratorNames,
  };
}
export async function parseDecorators(
  repoPath: string,
  filePath: string,
  context?: RepositorySourceContext,
): Promise<HandlerClassFact[]> {
  const snapshot = context?.get(filePath);
  const text = snapshot?.text
    ?? await fs.readFile(path.join(repoPath, filePath), 'utf8');
  const sf = snapshot?.sourceFile() ?? createSourceFile(filePath, text);
  const lookups = collectStringLookups(sf);
  const handlers: HandlerClassFact[] = [];
  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node)) {
      const handler = parseHandlerClass(node, lookups, sf, filePath);
      if (handler) handlers.push(handler);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return handlers;
}
