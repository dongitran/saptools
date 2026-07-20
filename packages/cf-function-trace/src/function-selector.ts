import ts from "typescript";

import { TraceDataError } from "./errors.js";
import { validateFunctionSelector } from "./validation.js";

export type FunctionKind =
  | "function"
  | "arrow"
  | "function-expression"
  | "class-method"
  | "object-method"
  | "constructor"
  | "getter"
  | "setter";

export interface FunctionCandidate {
  readonly selector: string;
  readonly localName: string;
  readonly kind: FunctionKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly bodyStartOffset: number;
  readonly bodyEndOffset: number;
  readonly asynchronous: boolean;
  readonly containsAwait: boolean;
}

export interface FunctionSelection {
  readonly candidate: FunctionCandidate;
  readonly candidates: readonly FunctionCandidate[];
}

function propertyName(node: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (node === undefined) {
    return undefined;
  }
  return ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
    ? node.text
    : undefined;
}

function hasAsyncModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
  ) === true;
}

function containsAwait(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (child.kind === ts.SyntaxKind.AwaitExpression) {
      found = true;
      return;
    }
    if (ts.isFunctionLike(child)) {
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function toCandidate(
  source: ts.SourceFile,
  node: ts.FunctionLikeDeclaration,
  selector: string,
  localName: string,
  kind: FunctionKind,
): FunctionCandidate {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  const body = node.body;
  const bodyStartOffset = body === undefined
    ? node.getStart(source)
    : body.getStart(source) + (ts.isBlock(body) ? 1 : 0);
  const bodyEndOffset = body?.getEnd() ?? node.getEnd();
  return {
    selector,
    localName,
    kind,
    startLine: start.line + 1,
    endLine: end.line + 1,
    startOffset: node.getStart(source),
    endOffset: node.getEnd(),
    bodyStartOffset,
    bodyEndOffset,
    asynchronous: hasAsyncModifier(node),
    containsAwait: containsAwait(node),
  };
}

function initializerCandidate(
  source: ts.SourceFile,
  initializer: ts.Expression | undefined,
  selector: string,
  localName: string,
  kind?: FunctionKind,
): FunctionCandidate | undefined {
  if (initializer === undefined) {
    return undefined;
  }
  if (ts.isArrowFunction(initializer)) {
    return toCandidate(source, initializer, selector, localName, kind ?? "arrow");
  }
  return ts.isFunctionExpression(initializer)
    ? toCandidate(source, initializer, selector, localName, kind ?? "function-expression")
    : undefined;
}

function variableCandidate(
  source: ts.SourceFile,
  declaration: ts.VariableDeclaration,
): FunctionCandidate | undefined {
  const name = propertyName(declaration.name);
  return name === undefined
    ? undefined
    : initializerCandidate(source, declaration.initializer, name, name);
}

function collectObjectMethods(
  source: ts.SourceFile,
  declaration: ts.VariableDeclaration,
  output: FunctionCandidate[],
): void {
  const owner = propertyName(declaration.name);
  const initializer = declaration.initializer;
  if (owner === undefined || initializer === undefined || !ts.isObjectLiteralExpression(initializer)) {
    return;
  }
  for (const property of initializer.properties) {
    const candidate = objectMemberCandidate(source, property, owner);
    if (candidate !== undefined) {
      output.push(candidate);
    }
  }
}

function objectMemberCandidate(
  source: ts.SourceFile,
  property: ts.ObjectLiteralElementLike,
  owner: string,
): FunctionCandidate | undefined {
  const name = propertyName(property.name);
  if (name === undefined) {
    return undefined;
  }
  if (ts.isMethodDeclaration(property)) {
    return toCandidate(source, property, `${owner}.${name}`, name, "object-method");
  }
  if (ts.isGetAccessorDeclaration(property)) {
    return toCandidate(source, property, `${owner}.${name}`, name, "getter");
  }
  if (ts.isSetAccessorDeclaration(property)) {
    return toCandidate(source, property, `${owner}.${name}`, name, "setter");
  }
  return ts.isPropertyAssignment(property)
    ? initializerCandidate(source, property.initializer, `${owner}.${name}`, name, "object-method")
    : undefined;
}

function assignedCandidate(source: ts.SourceFile, node: ts.Node): FunctionCandidate | undefined {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    return undefined;
  }
  const left = node.left;
  if (!ts.isPropertyAccessExpression(left) || !ts.isIdentifier(left.expression)) {
    return undefined;
  }
  const selector = `${left.expression.text}.${left.name.text}`;
  return initializerCandidate(source, node.right, selector, left.name.text);
}

function classMemberCandidate(
  source: ts.SourceFile,
  node: ts.Node,
  owner: string,
): FunctionCandidate | undefined {
  if (ts.isConstructorDeclaration(node)) {
    return toCandidate(source, node, `${owner}.constructor`, "constructor", "constructor");
  }
  if (ts.isMethodDeclaration(node)) {
    return namedClassFunctionCandidate(source, node, owner, "class-method");
  }
  if (ts.isGetAccessorDeclaration(node)) {
    return namedClassFunctionCandidate(source, node, owner, "getter");
  }
  if (ts.isSetAccessorDeclaration(node)) {
    return namedClassFunctionCandidate(source, node, owner, "setter");
  }
  if (ts.isPropertyDeclaration(node)) {
    const name = propertyName(node.name);
    return name === undefined
      ? undefined
      : initializerCandidate(source, node.initializer, `${owner}.${name}`, name);
  }
  return undefined;
}

function namedClassFunctionCandidate(
  source: ts.SourceFile,
  node: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
  owner: string,
  kind: "class-method" | "getter" | "setter",
): FunctionCandidate | undefined {
  const name = propertyName(node.name);
  return name === undefined ? undefined : toCandidate(source, node, `${owner}.${name}`, name, kind);
}

function collectStandaloneNode(
  source: ts.SourceFile,
  node: ts.Node,
  output: FunctionCandidate[],
): void {
  if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
    output.push(toCandidate(source, node, node.name.text, node.name.text, "function"));
    return;
  }
  if (!ts.isVariableDeclaration(node)) {
    const candidate = assignedCandidate(source, node);
    if (candidate !== undefined) {
      output.push(candidate);
    }
    return;
  }
  const candidate = variableCandidate(source, node);
  if (candidate !== undefined) {
    output.push(candidate);
  }
  collectObjectMethods(source, node, output);
}

function collectCandidates(source: ts.SourceFile): readonly FunctionCandidate[] {
  const output: FunctionCandidate[] = [];
  const visit = (node: ts.Node, owner?: string): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      for (const member of node.members) {
        visit(member, node.name.text);
      }
      return;
    }
    if (owner !== undefined) {
      const candidate = classMemberCandidate(source, node, owner);
      if (candidate !== undefined) {
        output.push(candidate);
        return;
      }
    }
    if (ts.isMethodDeclaration(node)) {
      return;
    }
    if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      return;
    }
    collectStandaloneNode(source, node, output);
    ts.forEachChild(node, (child) => {
      visit(child);
    });
  };
  visit(source);
  return output.sort((left, right) => {
    if (left.startOffset !== right.startOffset) {
      return left.startOffset - right.startOffset;
    }
    return left.selector < right.selector ? -1 : left.selector > right.selector ? 1 : 0;
  });
}

function matchingCandidates(candidates: readonly FunctionCandidate[], selector: string): readonly FunctionCandidate[] {
  return selector.includes(".")
    ? candidates.filter((candidate) => candidate.selector === selector)
    : candidates.filter((candidate) => candidate.localName === selector);
}

export function resolveFunctionSelector(fileName: string, sourceText: string, rawSelector: string): FunctionSelection {
  const selector = validateFunctionSelector(rawSelector);
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const candidates = collectCandidates(source);
  const matches = matchingCandidates(candidates, selector);
  if (matches.length === 0) {
    throw new TraceDataError("FUNCTION_NOT_FOUND", `Function ${selector} was not found.`);
  }
  if (matches.length > 1) {
    throw new TraceDataError("AMBIGUOUS_FUNCTION", `Function ${selector} is ambiguous.`, matches);
  }
  const candidate = matches[0];
  if (candidate === undefined) {
    throw new TraceDataError("FUNCTION_NOT_FOUND", `Function ${selector} was not found.`);
  }
  if (candidate.asynchronous || candidate.containsAwait) {
    throw new TraceDataError("UNSUPPORTED_ASYNC_FUNCTION", `Function ${selector} crosses an async boundary.`);
  }
  return { candidate, candidates };
}
