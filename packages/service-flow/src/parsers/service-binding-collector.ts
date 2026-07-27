import ts from 'typescript';
import type { ServiceBindingFact } from '../types.js';
import { normalizePath } from '../utils/path-utils.js';
import {
  connectFactFromCall,
  lineOf,
  transactionReceiverName,
  unwrapCall,
  unwrapIdentityExpression,
  type ClassHelperReturn,
  type HelperBinding,
  type ImportBinding,
} from './service-binding-parser-helpers.js';
import {
  createBindingLexicalIndex,
  type BindingLexicalIndex,
  type BindingSiteCandidate,
} from './binding-lexical-scope.js';
import { selectVisibleBinding } from './binding-visibility.js';
import {
  arrayAssignmentName,
  arrayBindingName,
  bindingValueAtSite,
  collectReturnedObjectBindings,
  directConnectFactFromFunctionLike,
  functionLikeInitializer,
} from './service-binding-helper-flow.js';

type ResolvedHelper = { helper: HelperBinding; imp?: ImportBinding };
type BindingEvent = {
  pos: number;
  node: ts.VariableDeclaration | ts.BinaryExpression;
};

export interface ServiceBindingCollectorInput {
  source: ts.SourceFile;
  filePath: string;
  imports: ImportBinding[];
  classHelpers: ClassHelperReturn[];
  loadHelperBindings: (filePath: string) => Promise<HelperBinding[]>;
}

function bindingAtSite(
  fact: ServiceBindingFact,
  node: ts.Node,
  source: ts.SourceFile,
): ServiceBindingFact {
  return {
    ...fact,
    bindingSiteStartOffset: node.getStart(source),
    bindingSiteEndOffset: node.getEnd(),
  };
}

function bindingEvents(source: ts.SourceFile): BindingEvent[] {
  const events: BindingEvent[] = [];
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node))
      events.push({ pos: node.getStart(source), node });
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      events.push({ pos: node.getStart(source), node });
    ts.forEachChild(node, visit);
  }
  visit(source);
  return events.sort((left, right) => left.pos - right.pos);
}

function destructuredTarget(
  property: ts.ObjectLiteralElementLike,
): { propertyName?: string; targetName?: string } {
  if (ts.isShorthandPropertyAssignment(property))
    return {
      propertyName: property.name.text,
      targetName: property.name.text,
    };
  if (!ts.isPropertyAssignment(property)) return {};
  const propertyName = ts.isIdentifier(property.name)
    || ts.isStringLiteralLike(property.name)
    ? property.name.text
    : undefined;
  return {
    propertyName,
    targetName: ts.isIdentifier(property.initializer)
      ? property.initializer.text
      : undefined,
  };
}

class ServiceBindingCollector {
  private readonly sourceFile: string;
  private readonly lexicalIndex: BindingLexicalIndex;
  private readonly out: ServiceBindingFact[] = [];
  private readonly helperCache = new Map<string, HelperBinding[]>();
  private readonly localObjectHelpers = new Map<string, HelperBinding[]>();
  private readonly localDirectHelpers = new Map<string, HelperBinding>();
  private readonly objectHelperVariables: Array<BindingSiteCandidate<
    ResolvedHelper[]
  >> = [];

  constructor(private readonly input: ServiceBindingCollectorInput) {
    this.sourceFile = normalizePath(input.filePath);
    this.lexicalIndex = createBindingLexicalIndex(input.source);
  }

  async collect(): Promise<ServiceBindingFact[]> {
    this.collectLocalHelpers();
    for (const event of bindingEvents(this.input.source))
      if (ts.isVariableDeclaration(event.node))
        await this.recordDeclaration(event.node);
      else
        await this.recordAssignment(event.node);
    return this.out;
  }

  private helperFact(
    name: string,
    node: ts.Node,
    helper: ts.FunctionLikeDeclaration,
  ): void {
    const direct = directConnectFactFromFunctionLike(helper);
    if (direct)
      this.localDirectHelpers.set(name, {
        ...direct,
        exportedName: name,
        sourceFile: this.sourceFile,
        sourceLine: lineOf(this.input.source, node),
      });
    const rows = [...collectReturnedObjectBindings(helper)]
      .map(([returnedProperty, fact]): HelperBinding => ({
        ...fact,
        exportedName: name,
        returnedProperty,
        sourceFile: this.sourceFile,
        sourceLine: lineOf(this.input.source, node),
      }));
    if (rows.length > 0) this.localObjectHelpers.set(name, rows);
  }

  private collectLocalHelpers(): void {
    for (const statement of this.input.source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name)
        this.helperFact(statement.name.text, statement, statement);
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const helper = functionLikeInitializer(declaration.initializer);
        if (helper) this.helperFact(
          declaration.name.text, declaration, helper,
        );
      }
    }
  }

  private async importedHelpers(localName: string): Promise<ResolvedHelper[]> {
    const imported = this.input.imports.find((item) =>
      item.localName === localName && item.sourceFile);
    if (!imported?.sourceFile) return [];
    if (!this.helperCache.has(imported.sourceFile))
      this.helperCache.set(
        imported.sourceFile,
        await this.input.loadHelperBindings(imported.sourceFile),
      );
    return (this.helperCache.get(imported.sourceFile) ?? [])
      .filter((helper) => helper.exportedName === imported.exportedName)
      .map((helper) => ({ imp: imported, helper }));
  }

  private async importedHelper(localName: string): Promise<ResolvedHelper | undefined> {
    return (await this.importedHelpers(localName))
      .find((row) => !row.helper.returnedProperty);
  }

  private bindingCandidates(): Array<BindingSiteCandidate<ServiceBindingFact>> {
    return this.out.map((fact) => ({
      variableName: fact.variableName,
      bindingSiteStartOffset: fact.bindingSiteStartOffset,
      bindingSiteEndOffset: fact.bindingSiteEndOffset,
      value: fact,
    }));
  }

  private bindingForVariable(
    variableName: string,
    node: ts.Node,
  ): ServiceBindingFact | undefined {
    const selected = selectVisibleBinding(
      this.lexicalIndex, this.bindingCandidates(), variableName, node,
    );
    if (!selected.site?.deterministic
      || selected.declarationSite?.declarationKind === 'var') return undefined;
    return selected.candidate?.value;
  }

  private cloneAlias(
    targetName: string,
    sourceName: string,
    aliasKind: 'identity' | 'identity-assignment' | 'transaction',
    node: ts.Node,
  ): void {
    const existing = this.bindingForVariable(sourceName, node);
    if (!existing) return;
    const helperChain = [...(existing.helperChain ?? []), {
      callerVariable: targetName,
      aliasOf: sourceName,
      aliasKind,
      scopeRule: 'exact_lexical_scope',
      ...(aliasKind === 'transaction'
        ? { transactionAliasSource: sourceName }
        : {}),
    }];
    this.out.push(bindingAtSite({
      ...existing,
      variableName: targetName,
      sourceLine: lineOf(this.input.source, node),
      helperChain,
    }, node, this.input.source));
  }

  private recordIdentityAlias(declaration: ts.VariableDeclaration): void {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return;
    const source = unwrapIdentityExpression(declaration.initializer);
    if (ts.isIdentifier(source))
      this.cloneAlias(
        declaration.name.text, source.text, 'identity', declaration,
      );
  }

  private directBinding(
    targetName: string,
    call: ts.CallExpression,
    node: ts.Node,
    flow: 'declaration' | 'assignment',
  ): boolean {
    const direct = connectFactFromCall(call);
    if (!direct) return false;
    const helperChain = flow === 'assignment'
      ? [{
          callerVariable: targetName,
          assignedFrom: call.expression.getText(this.input.source),
          aliasKind: flow,
          scopeRule: 'exact_lexical_scope',
        }]
      : undefined;
    this.out.push(bindingAtSite({
      variableName: targetName,
      ...direct,
      sourceFile: this.sourceFile,
      sourceLine: lineOf(this.input.source, node),
      helperChain,
    }, node, this.input.source));
    return true;
  }

  private helperBindingFact(
    targetName: string,
    resolved: ResolvedHelper,
    call: ts.CallExpression,
    node: ts.Node,
    flow: 'declaration' | 'assignment',
  ): ServiceBindingFact {
    const assignment = flow === 'assignment'
      ? {
          assignedFrom: call.expression.getText(this.input.source),
          aliasKind: flow,
          scopeRule: 'exact_lexical_scope',
        }
      : {};
    return {
      variableName: targetName,
      alias: resolved.helper.alias,
      aliasExpr: resolved.helper.aliasExpr,
      destinationExpr: resolved.helper.destinationExpr,
      servicePathExpr: resolved.helper.servicePathExpr,
      isDynamic: resolved.helper.isDynamic,
      placeholders: resolved.helper.placeholders,
      sourceFile: this.sourceFile,
      sourceLine: lineOf(this.input.source, node),
      helperChain: [...(resolved.helper.helperChain ?? []), {
        bindingOrigin: 'single_hop_helper_return',
        callerVariable: targetName,
        ...assignment,
        importedHelper: call.expression.getText(this.input.source),
        importSource: resolved.imp?.sourceFile,
        exportedSymbol: resolved.imp?.exportedName
          ?? resolved.helper.exportedName,
        helperSourceFile: resolved.helper.sourceFile,
        helperSourceLine: resolved.helper.sourceLine,
      }],
    };
  }

  private async recordExpression(
    targetName: string,
    expression: ts.Expression,
    node: ts.Node,
    flow: 'declaration' | 'assignment',
  ): Promise<void> {
    const call = unwrapCall(expression);
    if (!call || this.directBinding(targetName, call, node, flow)) return;
    if (!ts.isIdentifier(call.expression)) return;
    const local = this.localDirectHelpers.get(call.expression.text);
    const resolved = local
      ? { helper: local }
      : await this.importedHelper(call.expression.text);
    if (resolved)
      this.out.push(bindingAtSite(
        this.helperBindingFact(targetName, resolved, call, node, flow),
        node,
        this.input.source,
      ));
  }

  private async helpersForCall(call: ts.CallExpression): Promise<ResolvedHelper[]> {
    if (!ts.isIdentifier(call.expression)) return [];
    const local = this.localObjectHelpers.get(call.expression.text) ?? [];
    const imported = await this.importedHelpers(call.expression.text);
    return [...local.map((helper) => ({ helper })), ...imported];
  }

  private async rememberObjectHelper(declaration: ts.VariableDeclaration): Promise<void> {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return;
    const call = unwrapCall(declaration.initializer);
    if (!call) return;
    const helpers = (await this.helpersForCall(call))
      .filter((row) => row.helper.returnedProperty);
    if (helpers.length > 0)
      this.objectHelperVariables.push(bindingValueAtSite(
        declaration.name.text, declaration, this.input.source, helpers,
      ));
  }

  private visibleObjectHelpers(variableName: string, node: ts.Node): ResolvedHelper[] {
    const selected = selectVisibleBinding(
      this.lexicalIndex, this.objectHelperVariables, variableName, node,
    );
    if (!selected.site?.deterministic
      || selected.declarationSite?.declarationKind === 'var') return [];
    return selected.candidate?.value ?? [];
  }

  private objectPropertyFact(
    targetName: string,
    expression: ts.PropertyAccessExpression,
    resolved: ResolvedHelper,
    node: ts.Node,
  ): ServiceBindingFact {
    return {
      variableName: targetName,
      alias: resolved.helper.alias,
      aliasExpr: resolved.helper.aliasExpr,
      destinationExpr: resolved.helper.destinationExpr,
      servicePathExpr: resolved.helper.servicePathExpr,
      isDynamic: resolved.helper.isDynamic,
      placeholders: resolved.helper.placeholders,
      sourceFile: this.sourceFile,
      sourceLine: lineOf(this.input.source, node),
      helperChain: [...(resolved.helper.helperChain ?? []), {
        callerVariable: targetName,
        sourceVariable: expression.expression.getText(this.input.source),
        returnedProperty: expression.name.text,
        assignedFromProperty: expression.getText(this.input.source),
        importSource: resolved.imp?.sourceFile,
        exportedSymbol: resolved.imp?.exportedName,
        helperSourceFile: resolved.helper.sourceFile,
        helperSourceLine: resolved.helper.sourceLine,
      }],
    };
  }

  private recordObjectProperty(
    targetName: string,
    expression: ts.Expression,
    node: ts.Node,
  ): boolean {
    const unwrapped = unwrapIdentityExpression(expression);
    if (!ts.isPropertyAccessExpression(unwrapped)
      || !ts.isIdentifier(unwrapped.expression)) return false;
    const matches = this.visibleObjectHelpers(
      unwrapped.expression.text, node,
    ).filter((row) => row.helper.returnedProperty === unwrapped.name.text);
    const resolved = matches.length === 1 ? matches[0] : undefined;
    if (!resolved) return false;
    this.out.push(bindingAtSite(
      this.objectPropertyFact(targetName, unwrapped, resolved, node),
      node,
      this.input.source,
    ));
    return true;
  }

  private returnedHelperFact(
    targetName: string,
    propertyName: string,
    resolved: ResolvedHelper,
    call: ts.CallExpression,
    node: ts.Node,
    assignment: boolean,
  ): ServiceBindingFact {
    return {
      variableName: targetName,
      alias: resolved.helper.alias,
      aliasExpr: resolved.helper.aliasExpr,
      destinationExpr: resolved.helper.destinationExpr,
      servicePathExpr: resolved.helper.servicePathExpr,
      isDynamic: resolved.helper.isDynamic,
      placeholders: resolved.helper.placeholders,
      sourceFile: this.sourceFile,
      sourceLine: lineOf(this.input.source, node),
      helperChain: [...(resolved.helper.helperChain ?? []), {
        callerVariable: targetName,
        ...(assignment ? {
          assignedFrom: call.expression.getText(this.input.source),
          aliasKind: 'assignment',
          scopeRule: 'exact_lexical_scope',
        } : { helperFunction: call.expression.getText(this.input.source) }),
        returnedProperty: propertyName,
        importSource: resolved.imp?.sourceFile,
        exportedSymbol: resolved.imp?.exportedName,
        helperSourceFile: resolved.helper.sourceFile,
        helperSourceLine: resolved.helper.sourceLine,
      }],
    };
  }

  private async recordDestructuredHelper(
    declaration: ts.VariableDeclaration,
  ): Promise<void> {
    if (!ts.isObjectBindingPattern(declaration.name)
      || !declaration.initializer) return;
    const call = unwrapCall(declaration.initializer);
    if (!call) return;
    const helpers = await this.helpersForCall(call);
    for (const element of declaration.name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const propertyName = element.propertyName
        && ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : element.name.text;
      const matches = helpers.filter((row) =>
        row.helper.returnedProperty === propertyName);
      const resolved = matches.length === 1 ? matches[0] : undefined;
      if (resolved)
        this.out.push(bindingAtSite(
          this.returnedHelperFact(
            element.name.text, propertyName, resolved,
            call, declaration, false,
          ),
          declaration,
          this.input.source,
        ));
    }
  }

  private async recordDestructuredAssignment(
    pattern: ts.ObjectLiteralExpression,
    expression: ts.Expression,
    node: ts.Node,
  ): Promise<void> {
    const call = unwrapCall(expression);
    if (!call) return;
    const helpers = await this.helpersForCall(call);
    for (const property of pattern.properties) {
      const target = destructuredTarget(property);
      if (!target.propertyName || !target.targetName) continue;
      const matches = helpers.filter((row) =>
        row.helper.returnedProperty === target.propertyName);
      const resolved = matches.length === 1 ? matches[0] : undefined;
      if (resolved)
        this.out.push(bindingAtSite(
          this.returnedHelperFact(
            target.targetName, target.propertyName, resolved,
            call, node, true,
          ),
          node,
          this.input.source,
        ));
    }
  }

  private recordClassHelper(declaration: ts.VariableDeclaration): void {
    if (!ts.isObjectBindingPattern(declaration.name)
      || !declaration.initializer) return;
    const call = unwrapCall(declaration.initializer);
    if (!call || !ts.isPropertyAccessExpression(call.expression)
      || call.expression.expression.kind !== ts.SyntaxKind.ThisKeyword) return;
    for (const element of declaration.name.elements)
      this.recordClassHelperElement(
        declaration, element, call.expression.name.text,
      );
  }

  private recordClassHelperElement(
    declaration: ts.VariableDeclaration,
    element: ts.BindingElement,
    helperName: string,
  ): void {
    if (!ts.isIdentifier(element.name)) return;
    const propertyName = element.propertyName
      && ts.isIdentifier(element.propertyName)
      ? element.propertyName.text
      : element.name.text;
    const helper = this.input.classHelpers.find((row) =>
      row.helperName === helperName && row.propertyName === propertyName);
    if (!helper) return;
    this.out.push(bindingAtSite({
      variableName: element.name.text,
      ...helper.fact,
      sourceFile: this.sourceFile,
      sourceLine: lineOf(this.input.source, declaration),
      helperChain: [{
        callerVariable: element.name.text,
        className: helper.className,
        classHelper: helper.helperName,
        returnedProperty: helper.propertyName,
        helperVariable: helper.variableName,
        helperSourceFile: this.sourceFile,
        helperSourceLine: helper.sourceLine,
      }],
    }, declaration, this.input.source));
  }

  private arrayElements(expression: ts.Expression): {
    elements: ts.NodeArray<ts.Expression>;
    promiseAll: boolean;
  } | undefined {
    const unwrapped = unwrapIdentityExpression(expression);
    if (ts.isArrayLiteralExpression(unwrapped))
      return { elements: unwrapped.elements, promiseAll: false };
    const call = unwrapCall(expression);
    if (!call || !ts.isPropertyAccessExpression(call.expression)
      || call.expression.name.text !== 'all'
      || call.expression.expression.getText(this.input.source) !== 'Promise')
      return undefined;
    const first = call.arguments[0];
    const container = first ? unwrapIdentityExpression(first) : undefined;
    return container && ts.isArrayLiteralExpression(container)
      ? { elements: container.elements, promiseAll: true }
      : undefined;
  }

  private appendArrayStep(
    fact: ServiceBindingFact,
    targetName: string,
    arrayIndex: number,
    promiseAll: boolean,
    sourceVariable?: string,
  ): void {
    fact.helperChain = [...(fact.helperChain ?? []), {
      callerVariable: targetName,
      targetVariable: targetName,
      ...(sourceVariable ? {
        sourceVariable,
        aliasKind: 'array-destructuring',
      } : {}),
      arrayIndex,
      promiseAll,
      arrayContainer: promiseAll ? 'Promise.all' : 'array_literal',
    }];
  }

  private async recordArrayElement(
    targetName: string,
    expression: ts.Expression,
    node: ts.Node,
    arrayIndex: number,
    promiseAll: boolean,
  ): Promise<void> {
    const before = this.out.length;
    await this.recordExpression(targetName, expression, node, 'declaration');
    const direct = this.out.length > before ? this.out.at(-1) : undefined;
    if (direct) {
      this.appendArrayStep(direct, targetName, arrayIndex, promiseAll);
      return;
    }
    const unwrapped = unwrapIdentityExpression(expression);
    if (!ts.isIdentifier(unwrapped)) return;
    const existing = this.bindingForVariable(unwrapped.text, node);
    if (!existing) return;
    const fact = bindingAtSite({
      ...existing,
      variableName: targetName,
      sourceLine: lineOf(this.input.source, node),
    }, node, this.input.source);
    this.appendArrayStep(
      fact, targetName, arrayIndex, promiseAll, unwrapped.text,
    );
    this.out.push(fact);
  }

  private async recordArrayDeclaration(
    declaration: ts.VariableDeclaration,
  ): Promise<void> {
    if (!ts.isArrayBindingPattern(declaration.name)
      || !declaration.initializer) return;
    const container = this.arrayElements(declaration.initializer);
    if (!container) return;
    for (let index = 0; index < declaration.name.elements.length; index += 1) {
      const targetName = arrayBindingName(
        declaration.name.elements[index],
      );
      const expression = container.elements[index];
      if (targetName && expression && !ts.isOmittedExpression(expression))
        await this.recordArrayElement(
          targetName, expression, declaration,
          index, container.promiseAll,
        );
    }
  }

  private async recordArrayAssignment(
    pattern: ts.ArrayLiteralExpression,
    expression: ts.Expression,
    node: ts.Node,
  ): Promise<void> {
    const container = this.arrayElements(expression);
    if (!container) return;
    for (let index = 0; index < pattern.elements.length; index += 1) {
      const targetName = arrayAssignmentName(pattern.elements[index]);
      const source = container.elements[index];
      if (!targetName || !source || ts.isOmittedExpression(source)) continue;
      await this.recordArrayElement(
        targetName, source, node, index, container.promiseAll,
      );
    }
  }

  private async recordDeclaration(
    declaration: ts.VariableDeclaration,
  ): Promise<void> {
    await this.recordDestructuredHelper(declaration);
    await this.recordArrayDeclaration(declaration);
    this.recordClassHelper(declaration);
    await this.rememberObjectHelper(declaration);
    if (ts.isIdentifier(declaration.name) && declaration.initializer)
      this.recordObjectProperty(
        declaration.name.text, declaration.initializer, declaration,
      );
    if (ts.isIdentifier(declaration.name) && declaration.initializer)
      await this.recordExpression(
        declaration.name.text, declaration.initializer,
        declaration, 'declaration',
      );
    this.recordIdentityAlias(declaration);
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return;
    const source = transactionReceiverName(declaration.initializer);
    if (source)
      this.cloneAlias(
        declaration.name.text, source, 'transaction', declaration,
      );
  }

  private async recordIdentifierAssignment(
    assignment: ts.BinaryExpression,
  ): Promise<void> {
    if (!ts.isIdentifier(assignment.left)) return;
    const right = unwrapIdentityExpression(assignment.right);
    if (ts.isIdentifier(right)) {
      this.cloneAlias(
        assignment.left.text, right.text,
        'identity-assignment', assignment,
      );
      return;
    }
    if (this.recordObjectProperty(
      assignment.left.text, assignment.right, assignment,
    )) return;
    await this.recordExpression(
      assignment.left.text, assignment.right, assignment, 'assignment',
    );
  }

  private async recordAssignment(assignment: ts.BinaryExpression): Promise<void> {
    if (ts.isIdentifier(assignment.left)) {
      await this.recordIdentifierAssignment(assignment);
      return;
    }
    const left = ts.isParenthesizedExpression(assignment.left)
      ? assignment.left.expression
      : assignment.left;
    if (ts.isObjectLiteralExpression(left))
      await this.recordDestructuredAssignment(
        left, assignment.right, assignment,
      );
    if (ts.isArrayLiteralExpression(left))
      await this.recordArrayAssignment(left, assignment.right, assignment);
  }
}

export async function collectServiceBindings(
  input: ServiceBindingCollectorInput,
): Promise<ServiceBindingFact[]> {
  return new ServiceBindingCollector(input).collect();
}
