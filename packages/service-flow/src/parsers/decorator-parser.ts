import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { HandlerClassFact, HandlerMethodFact } from '../types.js';
import { generatedOperationNameFromConstant } from '../linker/operation-decorator-normalizer.js';
import { createSourceFile } from './ts-project.js';
import { normalizePath } from '../utils/path-utils.js';

type DecoratorResolution = HandlerMethodFact['decoratorResolution'];
interface StringLookups {
  identifiers: Map<string, string>;
  enumMembers: Map<string, string>;
  objectProperties: Map<string, string>;
}

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
  };
  for (const statement of source.statements) {
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
function unresolved(rawExpression: string, reason: string): DecoratorResolution {
  return { rawExpression, resolutionKind: 'unresolved', unresolvedReason: reason };
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
): DecoratorResolution {
  if (!argument) return unresolved('', 'decorator_argument_missing');
  const rawExpression = argument.getText();
  const expression = unwrapExpression(argument);
  if (ts.isStringLiteralLike(expression))
    return { rawExpression, resolvedValue: expression.text, resolutionKind: 'literal' };
  if (ts.isIdentifier(expression)) {
    const value = lookups.identifiers.get(expression.text);
    return value === undefined
      ? unresolved(rawExpression, 'identifier_not_resolved_to_local_const_string')
      : { rawExpression, resolvedValue: value, resolutionKind: 'const_identifier' };
  }
  if (ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)) {
    const key = `${expression.expression.text}.${expression.name.text}`;
    const enumValue = lookups.enumMembers.get(key);
    if (enumValue !== undefined)
      return { rawExpression, resolvedValue: enumValue, resolutionKind: 'enum_member' };
    const objectValue = lookups.objectProperties.get(key);
    if (objectValue !== undefined)
      return { rawExpression, resolvedValue: objectValue, resolutionKind: 'const_object_property' };
  }
  const generatedValue = generatedConstant(rawExpression);
  if (generatedValue !== undefined)
    return {
      rawExpression,
      resolvedValue: generatedValue,
      resolutionKind: 'generated_constant_name',
    };
  if (ts.isPropertyAccessExpression(expression))
    return unresolved(rawExpression, 'property_access_not_resolved_to_local_string');
  return unresolved(rawExpression, 'unsupported_decorator_expression');
}
export async function parseDecorators(
  repoPath: string,
  filePath: string
): Promise<HandlerClassFact[]> {
  const text = await fs.readFile(path.join(repoPath, filePath), 'utf8');
  const sf = createSourceFile(filePath, text);
  const lookups = collectStringLookups(sf);
  const handlers: HandlerClassFact[] = [];
  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node)) {
      const className = node.name?.text ?? 'AnonymousHandler';
      const hasHandler = decs(node).some((d) => callName(d) === 'Handler');
      const methods = node.members.filter(ts.isMethodDeclaration).flatMap((m) =>
        decs(m)
          .filter((d) =>
            ['Func', 'Action', 'On', 'Event'].includes(callName(d))
          )
          .map((d) => {
            const decoratorResolution = resolveDecoratorArgument(firstArg(d), lookups);
            return {
              methodName: m.name.getText(),
              decoratorKind: callName(d),
              decoratorValue: decoratorResolution.resolvedValue,
              decoratorRawExpression: decoratorResolution.rawExpression,
              decoratorResolution,
              sourceFile: normalizePath(filePath),
              sourceLine: line(sf, m.getStart())
            };
          })
      );
      if (hasHandler || methods.length > 0)
        handlers.push({
          className,
          sourceFile: normalizePath(filePath),
          sourceLine: line(sf, node.getStart()),
          methods
        });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return handlers;
}
