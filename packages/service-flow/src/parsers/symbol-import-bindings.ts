import ts from 'typescript';

export type SymbolImportModuleKind = 'relative' | 'package';
export type SymbolImportBindingKind =
  | 'esm_named'
  | 'esm_default'
  | 'esm_namespace'
  | 'cjs_destructured'
  | 'cjs_namespace';
export type SymbolImportReferenceShape =
  | 'identifier'
  | 'namespace_member'
  | 'static_member'
  | 'default_member';

export interface PackageModuleRequest {
  packageName: string;
  moduleSubpath: string;
}

export interface SymbolImportBinding {
  version: 1;
  moduleKind: SymbolImportModuleKind;
  bindingKind: SymbolImportBindingKind;
  localName: string;
  importedName: string | null;
  requestedPackageName: string | null;
  requestedModuleSubpath: string | null;
  rawModuleSpecifier: string;
  typeOnly: boolean;
  bindingSiteStartOffset: number;
  bindingSiteEndOffset: number;
}

export interface SymbolImportReference extends SymbolImportBinding {
  referenceShape: SymbolImportReferenceShape;
  referencedMemberName: string | null;
  requestedPublicName: string;
}

const packagePart = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const invalidPackageSpecifierCharacter = /[\\:?#]/;

function hasInvalidSubpath(parts: string[]): boolean {
  return parts.some((part) =>
    !part || part === '.' || part === '..' || !packagePart.test(part));
}

function invalidPackageSpecifier(specifier: string): boolean {
  return !specifier || specifier.startsWith('.')
    || invalidPackageSpecifierCharacter.test(specifier);
}

function validPackageParts(parts: string[], scoped: boolean): boolean {
  if (parts.some((part) => !part)) return false;
  if (scoped && (parts.length !== 2 || !parts[0]?.startsWith('@')))
    return false;
  return !hasInvalidSubpath(parts.map((part) => part.replace(/^@/, '')));
}

export function packageModuleRequest(
  specifier: string,
): PackageModuleRequest | undefined {
  if (invalidPackageSpecifier(specifier)) return undefined;
  const parts = specifier.split('/');
  const scoped = specifier.startsWith('@');
  const packageParts = scoped ? parts.slice(0, 2) : parts.slice(0, 1);
  const subpathParts = scoped ? parts.slice(2) : parts.slice(1);
  if (!validPackageParts(packageParts, scoped)
    || hasInvalidSubpath(subpathParts)) return undefined;
  return {
    packageName: packageParts.join('/'),
    moduleSubpath: subpathParts.length > 0
      ? `./${subpathParts.join('/')}`
      : '.',
  };
}

function moduleFields(specifier: string): Pick<
  SymbolImportBinding,
  'moduleKind' | 'requestedPackageName' | 'requestedModuleSubpath'
> | undefined {
  if (specifier.startsWith('.')) return {
    moduleKind: 'relative',
    requestedPackageName: null,
    requestedModuleSubpath: null,
  };
  const request = packageModuleRequest(specifier);
  return request ? {
    moduleKind: 'package',
    requestedPackageName: request.packageName,
    requestedModuleSubpath: request.moduleSubpath,
  } : undefined;
}

function binding(
  specifier: string,
  bindingKind: SymbolImportBindingKind,
  localName: string,
  importedName: string | null,
  typeOnly: boolean,
  site: ts.Identifier,
): SymbolImportBinding | undefined {
  const module = moduleFields(specifier);
  return module ? {
    version: 1,
    ...module,
    bindingKind,
    localName,
    importedName,
    rawModuleSpecifier: specifier,
    typeOnly,
    bindingSiteStartOffset: site.getStart(site.getSourceFile()),
    bindingSiteEndOffset: site.getEnd(),
  } : undefined;
}

function esmBindings(node: ts.ImportDeclaration): SymbolImportBinding[] {
  if (!ts.isStringLiteralLike(node.moduleSpecifier)) return [];
  const specifier = node.moduleSpecifier.text;
  const clause = node.importClause;
  if (!clause) return [];
  const bindings: SymbolImportBinding[] = [];
  if (clause.name) {
    const value = binding(
      specifier, 'esm_default', clause.name.text, 'default', clause.isTypeOnly,
      clause.name,
    );
    if (value) bindings.push(value);
  }
  const named = clause.namedBindings;
  if (named && ts.isNamespaceImport(named)) {
    const value = binding(
      specifier, 'esm_namespace', named.name.text, null, clause.isTypeOnly,
      named.name,
    );
    if (value) bindings.push(value);
  }
  if (named && ts.isNamedImports(named))
    bindings.push(...esmNamedBindings(specifier, clause.isTypeOnly, named));
  return bindings;
}

function esmNamedBindings(
  specifier: string,
  clauseTypeOnly: boolean,
  named: ts.NamedImports,
): SymbolImportBinding[] {
  return named.elements.flatMap((element) => {
    const value = binding(
      specifier,
      'esm_named',
      element.name.text,
      element.propertyName?.text ?? element.name.text,
      clauseTypeOnly || element.isTypeOnly,
      element.name,
    );
    return value ? [value] : [];
  });
}

function requireSpecifier(
  expression: ts.Expression | undefined,
): string | undefined {
  if (!expression || !ts.isCallExpression(expression)
    || !ts.isIdentifier(expression.expression)
    || expression.expression.text !== 'require'
    || lexicalIdentifierDeclaration(expression.expression)
    || expression.arguments.length !== 1) return undefined;
  const [argument] = expression.arguments;
  return argument && ts.isStringLiteralLike(argument)
    ? argument.text
    : undefined;
}

function cjsBindingElement(
  specifier: string,
  element: ts.BindingElement,
): SymbolImportBinding[] {
  if (element.dotDotDotToken || !ts.isIdentifier(element.name)
    || (element.propertyName
      && !ts.isIdentifier(element.propertyName)
      && !ts.isStringLiteralLike(element.propertyName))) return [];
  const importedName = element.propertyName
    ? element.propertyName.text
    : element.name.text;
  const value = binding(
    specifier, 'cjs_destructured', element.name.text, importedName, false,
    element.name,
  );
  return value ? [value] : [];
}

function cjsBindings(
  declaration: ts.VariableDeclaration,
): SymbolImportBinding[] {
  const specifier = requireSpecifier(declaration.initializer);
  if (!specifier) return [];
  if (ts.isIdentifier(declaration.name)) {
    const value = binding(
      specifier, 'cjs_namespace', declaration.name.text, null, false,
      declaration.name,
    );
    return value ? [value] : [];
  }
  if (!ts.isObjectBindingPattern(declaration.name)) return [];
  return declaration.name.elements.flatMap((element) =>
    cjsBindingElement(specifier, element));
}

function importEqualsBinding(
  statement: ts.ImportEqualsDeclaration,
): SymbolImportBinding[] {
  const reference = statement.moduleReference;
  if (!ts.isExternalModuleReference(reference)
    || !reference.expression
    || !ts.isStringLiteralLike(reference.expression)) return [];
  const value = binding(
    reference.expression.text,
    'cjs_namespace',
    statement.name.text,
    null,
    statement.isTypeOnly,
    statement.name,
  );
  return value ? [value] : [];
}

function compareBinary(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bindingKey(value: SymbolImportBinding): string {
  return [
    value.localName,
    value.rawModuleSpecifier,
    value.bindingKind,
    value.importedName ?? '',
    String(value.bindingSiteStartOffset).padStart(12, '0'),
    String(value.bindingSiteEndOffset).padStart(12, '0'),
  ].join('\0');
}

function collectNestedCjsBindings(
  source: ts.SourceFile,
): SymbolImportBinding[] {
  const bindings: SymbolImportBinding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)
      && (node.declarationList.flags & ts.NodeFlags.Const) !== 0)
      for (const declaration of node.declarationList.declarations)
        bindings.push(...cjsBindings(declaration));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
}

export function collectSymbolImportBindings(
  source: ts.SourceFile,
): SymbolImportBinding[] {
  const cached = importBindingCache.get(source);
  if (cached) return cached;
  const bindings = collectNestedCjsBindings(source);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement))
      bindings.push(...esmBindings(statement));
    if (ts.isImportEqualsDeclaration(statement))
      bindings.push(...importEqualsBinding(statement));
  }
  const sorted = bindings.sort((left, right) =>
    compareBinary(bindingKey(left), bindingKey(right)));
  importBindingCache.set(source, sorted);
  return sorted;
}

const importBindingCache =
  new WeakMap<ts.SourceFile, SymbolImportBinding[]>();

function matchingBinding(
  bindings: readonly SymbolImportBinding[],
  identifier: ts.Identifier,
): SymbolImportBinding | undefined {
  const matches = bindings.filter((value) =>
    value.localName === identifier.text
    && identifierMatchesBinding(identifier, value));
  return matches.length === 1 ? matches[0] : undefined;
}

const scopeDeclarationCache = new WeakMap<ts.Node, ts.Identifier[]>();

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingIdentifiers(element.name) : []);
}

function importIdentifiers(statement: ts.Statement): ts.Identifier[] {
  if (ts.isImportEqualsDeclaration(statement)) return [statement.name];
  if (!ts.isImportDeclaration(statement)) return [];
  const clause = statement.importClause;
  const values = clause?.name ? [clause.name] : [];
  const named = clause?.namedBindings;
  if (named && ts.isNamespaceImport(named)) values.push(named.name);
  if (named && ts.isNamedImports(named))
    values.push(...named.elements.map((element) => element.name));
  return values;
}

function statementIdentifiers(
  statement: ts.Statement,
  includeVar: boolean,
): ts.Identifier[] {
  if (ts.isVariableStatement(statement)) {
    const blockScoped = (statement.declarationList.flags
      & ts.NodeFlags.BlockScoped) !== 0;
    return includeVar || blockScoped
      ? statement.declarationList.declarations.flatMap((declaration) =>
          bindingIdentifiers(declaration.name))
      : [];
  }
  if ((ts.isFunctionDeclaration(statement)
    || ts.isClassDeclaration(statement)
    || ts.isEnumDeclaration(statement)) && statement.name)
    return [statement.name];
  return includeVar ? importIdentifiers(statement) : [];
}

function varIdentifiers(scope: ts.FunctionLikeDeclaration): ts.Identifier[] {
  const values: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== scope.body && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node)
      && ts.isVariableDeclarationList(node.parent)
      && (node.parent.flags & ts.NodeFlags.BlockScoped) === 0)
      values.push(...bindingIdentifiers(node.name));
    ts.forEachChild(node, visit);
  };
  if (scope.body) visit(scope.body);
  return values;
}

function functionIdentifiers(scope: ts.FunctionLikeDeclaration): ts.Identifier[] {
  const values = scope.parameters.flatMap((parameter) =>
    bindingIdentifiers(parameter.name));
  if ((ts.isFunctionDeclaration(scope)
    || ts.isFunctionExpression(scope)) && scope.name)
    values.push(scope.name);
  return [...values, ...varIdentifiers(scope)];
}

function loopIdentifiers(node: ts.Node): ts.Identifier[] {
  const initializer = ts.isForStatement(node)
    ? node.initializer
    : ts.isForInStatement(node) || ts.isForOfStatement(node)
      ? node.initializer
      : undefined;
  return initializer && ts.isVariableDeclarationList(initializer)
    && (initializer.flags & ts.NodeFlags.BlockScoped) !== 0
    ? initializer.declarations.flatMap((declaration) =>
        bindingIdentifiers(declaration.name))
    : [];
}

function lexicalFunctionScope(
  node: ts.Node,
): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node);
}

function uncachedScopeIdentifiers(node: ts.Node): ts.Identifier[] {
  if (ts.isSourceFile(node))
    return node.statements.flatMap((statement) =>
      statementIdentifiers(statement, true));
  if (ts.isClassExpression(node) && node.name) return [node.name];
  if (ts.isBlock(node) || ts.isModuleBlock(node))
    return node.statements.flatMap((statement) =>
      statementIdentifiers(statement, false));
  if (ts.isCaseBlock(node))
    return node.clauses.flatMap((clause) =>
      clause.statements.flatMap((statement) =>
        statementIdentifiers(statement, false)));
  if (lexicalFunctionScope(node)) return functionIdentifiers(node);
  if (ts.isCatchClause(node) && node.variableDeclaration)
    return bindingIdentifiers(node.variableDeclaration.name);
  return loopIdentifiers(node);
}

function scopeIdentifiers(node: ts.Node): ts.Identifier[] {
  const cached = scopeDeclarationCache.get(node);
  if (cached) return cached;
  const values = uncachedScopeIdentifiers(node);
  scopeDeclarationCache.set(node, values);
  return values;
}

export function lexicalIdentifierDeclarations(
  identifier: ts.Identifier,
): ts.Identifier[] {
  let current: ts.Node | undefined = identifier.parent;
  while (current) {
    const matches = scopeIdentifiers(current).filter((candidate) =>
      candidate.text === identifier.text);
    if (matches.length > 0) return matches;
    current = current.parent;
  }
  return [];
}

export function lexicalIdentifierDeclaration(
  identifier: ts.Identifier,
): ts.Identifier | undefined {
  const matches = lexicalIdentifierDeclarations(identifier);
  return matches.length === 1 ? matches[0] : undefined;
}

export function identifierMatchesDeclaration(
  identifier: ts.Identifier,
  startOffset: number,
  endOffset: number,
): boolean {
  const declaration = lexicalIdentifierDeclaration(identifier);
  return declaration?.getStart(identifier.getSourceFile()) === startOffset
    && declaration.getEnd() === endOffset;
}

function identifierMatchesBinding(
  identifier: ts.Identifier,
  value: SymbolImportBinding,
): boolean {
  return identifierMatchesDeclaration(
    identifier,
    value.bindingSiteStartOffset,
    value.bindingSiteEndOffset,
  );
}

export function derivedMemberImportReference(
  value: SymbolImportBinding,
  member: string,
): SymbolImportReference | undefined {
  const namespace = value.bindingKind === 'esm_namespace'
    || value.bindingKind === 'cjs_namespace';
  if (!member || (!namespace && value.importedName === null)) return undefined;
  const defaultBinding = value.bindingKind === 'esm_default';
  return {
    ...value,
    referenceShape: namespace
      ? 'namespace_member'
      : defaultBinding ? 'default_member' : 'static_member',
    referencedMemberName: member,
    requestedPublicName: namespace
      ? member
      : `${value.importedName}.${member}`,
  };
}

function identifierReference(
  expression: ts.Identifier,
  bindings: readonly SymbolImportBinding[],
): SymbolImportReference | undefined {
  const value = matchingBinding(bindings, expression);
  if (!value || value.importedName === null) return undefined;
  return {
    ...value,
    referenceShape: 'identifier',
    referencedMemberName: null,
    requestedPublicName: value.importedName,
  };
}

function memberReference(
  expression: ts.PropertyAccessExpression,
  bindings: readonly SymbolImportBinding[],
): SymbolImportReference | undefined {
  if (expression.questionDotToken || !ts.isIdentifier(expression.expression)
    || !ts.isIdentifier(expression.name)) return undefined;
  const value = matchingBinding(bindings, expression.expression);
  if (!value) return undefined;
  const member = expression.name.text;
  return derivedMemberImportReference(value, member);
}

function accessorMemberReference(
  expression: ts.PropertyAccessExpression,
  bindings: readonly SymbolImportBinding[],
): SymbolImportReference | undefined {
  const receiver = expression.expression;
  if (!ts.isCallExpression(receiver)
    || receiver.arguments.length !== 0
    || !ts.isPropertyAccessExpression(receiver.expression)
    || !ts.isIdentifier(receiver.expression.expression)
    || receiver.expression.questionDotToken
    || expression.questionDotToken) return undefined;
  const value = matchingBinding(
    bindings, receiver.expression.expression,
  );
  if (!value || value.importedName === null)
    return undefined;
  return {
    ...value,
    referenceShape: 'static_member',
    referencedMemberName: expression.name.text,
    requestedPublicName: `${value.importedName}.${expression.name.text}`,
  };
}

export function symbolImportReference(
  expression: ts.Expression,
  bindings: readonly SymbolImportBinding[],
): SymbolImportReference | undefined {
  if (ts.isIdentifier(expression))
    return identifierReference(expression, bindings);
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  return memberReference(expression, bindings)
    ?? accessorMemberReference(expression, bindings);
}
