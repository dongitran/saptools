import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

import {
  buildEndpointUrl,
  errorMessage,
  normalizeBearerToken,
  type DiscoveredApiEntity,
} from './discovery.js';

export interface RequestRunOptions {
  readonly baseUrl: string;
  readonly token?: string | null | undefined;
  readonly endpoint: DiscoveredApiEntity;
  readonly method: string;
  readonly payload?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface RequestRunResult {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface PromptAndRunOptions {
  readonly appId: string;
  readonly baseUrl: string;
  readonly token?: string | null | undefined;
  readonly entities: readonly DiscoveredApiEntity[];
  readonly input?: Readable | undefined;
  readonly output?: Writable | undefined;
  readonly timeoutMs?: number | undefined;
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const JSON_CONTENT_TYPE = 'application/json';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RESET = '\u001B[0m';
const GREEN = '\u001B[32m';
const CYAN = '\u001B[36m';
const YELLOW = '\u001B[33m';
const RED = '\u001B[31m';

export function buildCurlCommands(params: {
  readonly baseUrl: string;
  readonly token?: string | null | undefined;
  readonly entities: readonly DiscoveredApiEntity[];
}): readonly string[] {
  const authorizationHeader = authorizationHeaderValue(params.token);
  return params.entities.flatMap((entity) =>
    entity.methods.map((method) => buildCurlCommand({
      baseUrl: params.baseUrl,
      path: entity.path,
      method,
      authorizationHeader,
      includePayload: BODY_METHODS.has(method.toUpperCase()),
    }))
  );
}

function buildCurlCommand(params: {
  readonly baseUrl: string;
  readonly path: string;
  readonly method: string;
  readonly authorizationHeader?: string | undefined;
  readonly includePayload: boolean;
}): string {
  const parts = [
    'curl',
    '--fail-with-body',
    '--show-error',
    '-X',
    shellQuote(params.method.toUpperCase()),
    shellQuote(buildEndpointUrl(params.baseUrl, params.path)),
    '-H',
    shellQuote('Accept: application/json'),
  ];
  if (params.authorizationHeader !== undefined) {
    parts.push('-H', shellQuote(`Authorization: ${params.authorizationHeader}`));
  }
  if (params.includePayload) {
    parts.push('-H', shellQuote(`Content-Type: ${JSON_CONTENT_TYPE}`), '--data', shellQuote('{}'));
  }
  return parts.join(' ');
}

export async function promptAndRunRequest(params: PromptAndRunOptions): Promise<RequestRunResult> {
  const input = params.input ?? process.stdin;
  const output = params.output ?? process.stdout;
  const readline = createInterface({ input, output });
  try {
    const endpoint = await promptForChoice(readline, output, `Select an endpoint for ${params.appId}`, params.entities, (entity) =>
      `${entity.name} (${entity.methods.join(', ')}) ${entity.path}`
    );
    const method = await promptForChoice(readline, output, 'Select HTTP method', endpoint.methods, (value) => value);
    const payload = BODY_METHODS.has(method.toUpperCase())
      ? await promptForJsonPayload(readline, output)
      : undefined;
    return await runDiscoveredRequest({
      baseUrl: params.baseUrl,
      token: params.token,
      endpoint,
      method,
      payload,
      timeoutMs: params.timeoutMs,
    });
  } finally {
    readline.close();
  }
}

export async function runDiscoveredRequest(options: RequestRunOptions): Promise<RequestRunResult> {
  const method = options.method.toUpperCase();
  const headers: Record<string, string> = { Accept: JSON_CONTENT_TYPE };
  const authorizationHeader = authorizationHeaderValue(options.token);
  if (authorizationHeader !== undefined) {
    headers['Authorization'] = authorizationHeader;
  }
  const body = BODY_METHODS.has(method) ? normalizePayload(options.payload) : undefined;
  if (body !== undefined) {
    headers['Content-Type'] = JSON_CONTENT_TYPE;
  }
  const requestInit: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
  };
  if (body !== undefined) { requestInit.body = body; }
  const response = await fetch(buildEndpointUrl(options.baseUrl, options.endpoint.path), requestInit);
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body: await parseResponseBody(response),
  };
}

export function formatResponse(result: RequestRunResult): string {
  const statusColor = result.status >= 200 && result.status < 300 ? GREEN : RED;
  return [
    `${CYAN}Status:${RESET} ${statusColor}${String(result.status)} ${result.statusText}${RESET}`,
    `${CYAN}Headers:${RESET}`,
    colorizeJson(result.headers),
    `${CYAN}Body:${RESET}`,
    colorizeJson(result.body),
  ].join('\n');
}

async function promptForChoice<T>(
  readline: ReturnType<typeof createInterface>,
  output: Writable,
  message: string,
  choices: readonly T[],
  format: (choice: T) => string,
): Promise<T> {
  output.write(`\n${message}\n`);
  for (const [index, choice] of choices.entries()) {
    output.write(`  ${String(index + 1)}. ${format(choice)}\n`);
  }
  for (;;) {
    const answer = await readline.question('Choose a number: ');
    const selectedIndex = Number.parseInt(answer.trim(), 10) - 1;
    const selected = choices[selectedIndex];
    if (selected !== undefined) { return selected; }
    output.write(`Please enter a number between 1 and ${String(choices.length)}.\n`);
  }
}

async function promptForJsonPayload(
  readline: ReturnType<typeof createInterface>,
  output: Writable,
): Promise<string> {
  for (;;) {
    const answer = await readline.question('JSON payload [{}]: ');
    const payload = answer.trim() === '' ? '{}' : answer;
    const validation = validateJsonPayload(payload);
    if (validation === true) { return payload; }
    output.write(`${validation}\n`);
  }
}

function normalizePayload(payload: string | undefined): string {
  if (payload === undefined || payload.trim() === '') { return '{}'; }
  return JSON.stringify(JSON.parse(payload));
}

function validateJsonPayload(value: string): true | string {
  try {
    normalizePayload(value);
    return true;
  } catch (error) {
    return `Invalid JSON payload: ${errorMessage(error)}`;
  }
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') { return null; }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes(JSON_CONTENT_TYPE)) {
    try { return JSON.parse(text); } catch { return text; }
  }
  try { return JSON.parse(text); } catch { return text; }
}

function colorizeJson(value: unknown): string {
  if (value === undefined) { return 'undefined'; }
  const json = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const parts: string[] = [];
  let index = 0;
  while (index < json.length) {
    const quoteIndex = json.indexOf('"', index);
    if (quoteIndex === -1) {
      parts.push(json.slice(index));
      break;
    }
    if (quoteIndex > index) { parts.push(json.slice(index, quoteIndex)); }
    const stringEndIndex = findJsonStringEnd(json, quoteIndex);
    const token = json.slice(quoteIndex, stringEndIndex);
    const nextChar = nextNonWhitespace(json, stringEndIndex);
    const previousChar = previousNonWhitespace(json, quoteIndex);
    if (nextChar === ':') {
      parts.push(`${YELLOW}${token}${RESET}`);
    } else if (previousChar === ':') {
      parts.push(`${GREEN}${token}${RESET}`);
    } else {
      parts.push(token);
    }
    index = stringEndIndex;
  }
  return parts.join('');
}

function findJsonStringEnd(source: string, startIndex: number): number {
  let index = startIndex + 1;
  let escaped = false;
  while (index < source.length) {
    const char = source[index];
    index++;
    if (char === undefined) { continue; }
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { return index; }
  }
  return source.length;
}

function nextNonWhitespace(source: string, startIndex: number): string | undefined {
  let index = startIndex;
  while (index < source.length) {
    const char = source[index];
    if (char === undefined) { return undefined; }
    if (!isJsonWhitespace(char)) { return char; }
    index++;
  }
  return undefined;
}

function previousNonWhitespace(source: string, beforeIndex: number): string | undefined {
  let index = beforeIndex - 1;
  while (index >= 0) {
    const char = source[index];
    if (char === undefined) { return undefined; }
    if (!isJsonWhitespace(char)) { return char; }
    index--;
  }
  return undefined;
}

function isJsonWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t';
}

function authorizationHeaderValue(token: string | null | undefined): string | undefined {
  if (token === null || token === undefined || token.trim() === '') { return undefined; }
  return normalizeBearerToken(token);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
