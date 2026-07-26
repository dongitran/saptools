import path from 'node:path';
import ts from 'typescript';
import type { ServiceBindingFact } from '../types.js';
import { normalizePath } from '../utils/path-utils.js';
import {
  importsFor,
  lineOf,
  readSource,
  type ClassHelperReturn,
  type HelperBinding,
} from './service-binding-parser-helpers.js';
import {
  collectReturnedObjectBindings,
  directConnectFact,
  directConnectFactFromFunctionLike,
  functionLikeInitializer,
  type LocalBindingFact,
} from './014-service-binding-helper-flow.js';
import { collectServiceBindings } from './015-service-binding-collector.js';
import type { RepositorySourceContext } from './ts-project.js';

interface LocalHelperFact extends LocalBindingFact {
  sourceLine: number;
  returnedProperty?: string;
}

function directlyExportedNames(statement: ts.Statement): string[] {
  const direct = ts.canHaveModifiers(statement)
    && (ts.getModifiers(statement)?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
  if (!direct) return [];
  if (ts.isFunctionDeclaration(statement) && statement.name)
    return [statement.name.text];
  if (!ts.isVariableStatement(statement)) return [];
  return statement.declarationList.declarations.flatMap((declaration) =>
    ts.isIdentifier(declaration.name) ? [declaration.name.text] : []);
}

function namedExports(statement: ts.Statement): Array<{
  exportedName: string;
  localName: string;
}> {
  if (!ts.isExportDeclaration(statement)
    || !statement.exportClause
    || !ts.isNamedExports(statement.exportClause)) return [];
  return statement.exportClause.elements.map((element) => ({
    exportedName: element.name.text,
    localName: element.propertyName?.text ?? element.name.text,
  }));
}

function exportedLocalNames(source: ts.SourceFile): Map<string, string> {
  const exports = new Map<string, string>();
  for (const statement of source.statements) {
    for (const name of directlyExportedNames(statement))
      exports.set(name, name);
    for (const entry of namedExports(statement))
      exports.set(entry.exportedName, entry.localName);
  }
  return exports;
}

function recordFunctionFacts(
  facts: Map<string, LocalHelperFact>,
  localName: string,
  node: ts.Node,
  helper: ts.FunctionLikeDeclaration,
  source: ts.SourceFile,
): void {
  const sourceLine = lineOf(source, node);
  const direct = directConnectFactFromFunctionLike(helper);
  if (direct) facts.set(localName, { ...direct, sourceLine });
  for (const [returnedProperty, fact] of collectReturnedObjectBindings(helper))
    facts.set(`${localName}#${returnedProperty}`, {
      ...fact,
      returnedProperty,
      sourceLine,
    });
}

function localHelperFacts(source: ts.SourceFile): Map<string, LocalHelperFact> {
  const facts = new Map<string, LocalHelperFact>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name)
      recordFunctionFacts(
        facts, statement.name.text, statement, statement, source,
      );
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
        continue;
      const helper = functionLikeInitializer(declaration.initializer);
      if (helper)
        recordFunctionFacts(
          facts, declaration.name.text, declaration, helper, source,
        );
      else {
        const fact = directConnectFact(declaration.initializer);
        if (fact)
          facts.set(declaration.name.text, {
            ...fact,
            sourceLine: lineOf(source, declaration),
          });
      }
    }
  }
  return facts;
}

function exportedHelperFacts(
  source: ts.SourceFile,
  filePath: string,
): HelperBinding[] {
  const facts = localHelperFacts(source);
  const output: HelperBinding[] = [];
  for (const [exportedName, localName] of exportedLocalNames(source))
    for (const [key, fact] of facts) {
      const [factLocal, returnedProperty] = key.split('#');
      if (factLocal !== localName) continue;
      output.push({
        ...fact,
        exportedName,
        returnedProperty,
        sourceFile: normalizePath(filePath),
      });
    }
  return output;
}

async function helperBindings(
  repoPath: string,
  filePath: string,
  context?: RepositorySourceContext,
): Promise<HelperBinding[]> {
  const source = await readSource(
    path.join(repoPath, filePath), context, filePath,
  );
  return source ? exportedHelperFacts(source, filePath) : [];
}

function classHelperFacts(
  source: ts.SourceFile,
  className: string,
  helperName: string,
  helper: ts.FunctionLikeDeclaration,
): ClassHelperReturn[] {
  return [...collectReturnedObjectBindings(helper)].map(
    ([propertyName, fact]) => ({
      className,
      helperName,
      propertyName,
      variableName: propertyName,
      fact,
      sourceLine: lineOf(source, helper),
    }),
  );
}

function collectClassHelpers(source: ts.SourceFile): ClassHelperReturn[] {
  const helpers: ClassHelperReturn[] = [];
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) continue;
    for (const member of statement.members) {
      if (!ts.isPropertyDeclaration(member)
        || !ts.isIdentifier(member.name)
        || !member.initializer) continue;
      const helper = functionLikeInitializer(member.initializer);
      if (helper)
        helpers.push(...classHelperFacts(
          source, statement.name.text, member.name.text, helper,
        ));
    }
  }
  return helpers;
}

export async function parseServiceBindings(
  repoPath: string,
  filePath: string,
  context?: RepositorySourceContext,
): Promise<ServiceBindingFact[]> {
  const source = await readSource(
    path.join(repoPath, filePath), context, filePath,
  );
  if (!source) return [];
  return collectServiceBindings({
    source,
    filePath,
    imports: await importsFor(repoPath, filePath, source),
    classHelpers: collectClassHelpers(source),
    loadHelperBindings: async (helperFile) =>
      helperBindings(repoPath, helperFile, context),
  });
}
