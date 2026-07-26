import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { OutboundCallFact, ServiceBindingFact } from '../types.js';
import { normalizePath } from '../utils/path-utils.js';
import {
  classifyOutboundCallsInSource,
  type ClassifiedOutboundCall,
} from './outbound-call-classifier.js';
import {
  lineOf,
  literalText,
  parserEvidence,
} from './outbound-expression-analysis.js';
import { parseImportedWrapperCalls } from './imported-wrapper-parser.js';
import { parseServiceBindings } from './service-binding-parser.js';
import type { RepositorySourceContext } from './ts-project.js';

export {
  classifyOutboundCallsInSource,
  type ClassifiedOutboundCall,
};

interface LocalServiceOrigin {
  service: string;
  lookup: string;
  chain: string[];
}

interface LocalServiceOperation extends LocalServiceOrigin {
  operation: string;
  classifier: string;
}

export function containsSupportedOutboundCall(
  node: ts.Node,
  classified?: readonly ClassifiedOutboundCall[],
): boolean {
  const source = node.getSourceFile();
  const start = node.getFullStart();
  const end = node.getEnd();
  const calls = classified
    ?? classifyOutboundCallsInSource(source, source.fileName);
  return calls.some((call) =>
    call.node.getStart(source) >= start && call.node.getEnd() <= end);
}

function parsedSource(
  filePath: string,
  text: string,
  context?: RepositorySourceContext,
): ts.SourceFile {
  const snapshot = context?.get(filePath);
  return snapshot?.sourceFile() ?? ts.createSourceFile(
    filePath, text, ts.ScriptTarget.Latest, true,
    filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
}

export async function parseOutboundCalls(
  repoPath: string,
  filePath: string,
  context?: RepositorySourceContext,
  classified?: readonly ClassifiedOutboundCall[],
  preparedBindings?: readonly ServiceBindingFact[],
): Promise<OutboundCallFact[]> {
  const snapshot = context?.get(filePath);
  const text = snapshot?.text
    ?? await fs.readFile(path.join(repoPath, filePath), 'utf8');
  const source = parsedSource(filePath, text, context);
  const bindings = preparedBindings ?? await parseServiceBindings(
    repoPath, filePath, context,
  );
  const bindingNames = new Set(bindings.map((binding) =>
    binding.variableName));
  const importedWrappers = await parseImportedWrapperCalls(
    repoPath, filePath, source, bindingNames, context,
  );
  const nativeCalls = classified
    ?? classifyOutboundCallsInSource(source, filePath);
  return [
    ...nativeCalls.map((call) => call.fact),
    ...importedWrappers,
    ...parseLocalServiceCalls(text, filePath, source),
  ];
}

function localServiceCallFact(
  parsed: LocalServiceOperation,
  node: ts.CallExpression,
  text: string,
  filePath: string,
  source: ts.SourceFile,
): OutboundCallFact {
  const transport = ['send', 'emit', 'publish', 'on']
    .includes(parsed.operation);
  return {
    callType: 'local_service_call',
    operationPathExpr: `/${parsed.operation}`,
    payloadSummary: parsed.service,
    localServiceName: parsed.service,
    localServiceLookup: parsed.lookup,
    aliasChain: parsed.chain,
    sourceFile: normalizePath(filePath),
    sourceLine: lineOf(text, node.getStart(source)),
    callSiteStartOffset: node.getStart(source),
    callSiteEndOffset: node.getEnd(),
    confidence: 0.9,
    unresolvedReason: transport ? 'transport_client_method' : undefined,
    evidence: parserEvidence(source, node, {
      classifier: parsed.classifier,
      parserCallType: parsed.operation === 'send'
        ? 'transport_client_method' : parsed.classifier,
      localServiceLookup: parsed.lookup,
      localServiceName: parsed.service,
      operation: parsed.operation,
      aliasChain: parsed.chain,
    }),
  };
}

function parseLocalServiceCalls(
  text: string,
  filePath: string,
  source: ts.SourceFile,
): OutboundCallFact[] {
  const aliases = new Map<string, LocalServiceOrigin>();
  const calls: OutboundCallFact[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.initializer) {
      const origin = serviceLookup(node.initializer, aliases);
      if (origin) aliases.set(node.name.text, {
        ...origin, chain: [...origin.chain, node.name.text],
      });
    }
    if (ts.isCallExpression(node)) {
      const parsed = serviceOperationCall(node, aliases);
      if (parsed && parsed.operation !== 'entities')
        calls.push(localServiceCallFact(
          parsed, node, text, filePath, source,
        ));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function serviceLookup(
  expression: ts.Expression,
  aliases: Map<string, LocalServiceOrigin>,
): LocalServiceOrigin | undefined {
  if (ts.isIdentifier(expression)) return aliases.get(expression.text);
  if (ts.isPropertyAccessExpression(expression)
    && expression.expression.getText() === 'cds.services') return {
    service: expression.name.text,
    lookup: expression.getText(),
    chain: [expression.getText()],
  };
  if (!ts.isElementAccessExpression(expression)
    || expression.expression.getText() !== 'cds.services'
    || !ts.isStringLiteral(expression.argumentExpression)) return undefined;
  return {
    service: expression.argumentExpression.text,
    lookup: expression.getText(),
    chain: [expression.getText()],
  };
}

function positionalSendOperation(
  node: ts.CallExpression,
): { operation: string; classifier: string } | undefined {
  const first = literalText(node.arguments[0]);
  const second = literalText(node.arguments[1]);
  const method = first?.toUpperCase();
  if (method && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
    .includes(method) && second) return {
    operation: second.replace(/^\//, ''),
    classifier: 'cap_service_send_method_path',
  };
  return first ? {
    operation: first.replace(/^\//, ''),
    classifier: 'cap_service_send_local_dispatch',
  } : undefined;
}

function serviceOperationCall(
  node: ts.CallExpression,
  aliases: Map<string, LocalServiceOrigin>,
): LocalServiceOperation | undefined {
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  const origin = serviceLookup(expression.expression, aliases);
  if (!origin) return undefined;
  const send = expression.name.text === 'send'
    ? positionalSendOperation(node) : undefined;
  if (send) return { ...origin, ...send };
  return {
    ...origin,
    operation: expression.name.text,
    classifier: 'local_cap_service_call',
  };
}
