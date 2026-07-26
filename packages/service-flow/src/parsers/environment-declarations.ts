import type { RepositorySourceContext } from './ts-project.js';

export const ENVIRONMENT_DECLARATIONS_SCHEMA =
  'service-flow/environment-declarations@1';
export const ENVIRONMENT_DECLARATION_RECORD_CAP = 32;
export const EVENT_ENVIRONMENT_KEY_ALLOWLIST = ['SHARD_CODE'] as const;

export type EventEnvironmentKey =
  typeof EVENT_ENVIRONMENT_KEY_ALLOWLIST[number];
export type EnvironmentDeclarationProvenance =
  | 'env_declaration_manifest'
  | 'env_declaration_mta'
  | 'env_declaration_dotenv'
  | 'env_declaration_dev';

export interface EnvironmentDeclaration {
  key: EventEnvironmentKey;
  value: string;
  provenance: EnvironmentDeclarationProvenance;
  sourceFile: string;
  startOffset: number;
  endOffset: number;
}

export interface EnvironmentDeclarationsFact {
  schema: typeof ENVIRONMENT_DECLARATIONS_SCHEMA;
  status: 'complete' | 'ambiguous' | 'not_applicable' | 'incomplete';
  reason: string | null;
  recordCap: typeof ENVIRONMENT_DECLARATION_RECORD_CAP;
  total: number;
  shown: number;
  omitted: number;
  declarations: EnvironmentDeclaration[];
}

const allowedKeys = new Set<string>(EVENT_ENVIRONMENT_KEY_ALLOWLIST);
const allowedProvenance = new Set<EnvironmentDeclarationProvenance>([
  'env_declaration_manifest',
  'env_declaration_mta',
  'env_declaration_dotenv',
  'env_declaration_dev',
]);
const environmentValueLimit = 512;
const dynamicEnvironmentValue = /\$\{|\$\(|~\{|\(\(/;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function scalarValue(raw: string): string | undefined {
  const value = raw.trim();
  if (!value || /^[{[*&!>|]/.test(value)) return undefined;
  if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'")))
    return value.slice(1, -1);
  return /[\r\n]/.test(value) ? undefined : value;
}

function declaration(
  key: string,
  value: unknown,
  provenance: EnvironmentDeclarationProvenance,
  sourceFile: string,
  startOffset: number,
): EnvironmentDeclaration[] {
  if (!allowedKeys.has(key) || typeof value !== 'string'
    || !value || value.length > environmentValueLimit
    || hasControlCharacter(value)
    || dynamicEnvironmentValue.test(value)) return [];
  return [{
    key: key as EventEnvironmentKey,
    value,
    provenance,
    sourceFile,
    startOffset,
    endOffset: startOffset + value.length,
  }];
}

function valueOffset(
  text: string,
  value: string,
  after: number,
): number {
  const direct = text.indexOf(value, Math.max(0, after));
  return direct >= 0 ? direct : Math.max(0, after);
}

function jsonDeclarations(
  filePath: string,
  text: string,
): EnvironmentDeclaration[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return [];
  const env = (parsed as Record<string, unknown>).env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return [];
  return EVENT_ENVIRONMENT_KEY_ALLOWLIST.flatMap((key) => {
    const value = (env as Record<string, unknown>)[key];
    const keyOffset = text.indexOf(`"${key}"`);
    const offset = typeof value === 'string'
      ? valueOffset(text, value, keyOffset + key.length + 2) : keyOffset;
    return declaration(
      key, value, 'env_declaration_dev', filePath, Math.max(0, offset),
    );
  });
}

function dotenvDeclarations(
  filePath: string,
  text: string,
): EnvironmentDeclaration[] {
  const values: EnvironmentDeclaration[] = [];
  let offset = 0;
  for (const line of text.split(/\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/
      .exec(line);
    const value = match?.[2] === undefined
      ? undefined : scalarValue(match[2]);
    if (match?.[1] && value !== undefined)
      values.push(...declaration(
        match[1], value, 'env_declaration_dotenv', filePath,
        offset + valueOffset(line, value, line.indexOf('=') + 1),
      ));
    offset += line.length + 1;
  }
  return values;
}

function indentation(value: string): number {
  return /^\s*/.exec(value)?.[0].length ?? 0;
}

function yamlDeclarations(
  filePath: string,
  text: string,
  provenance: EnvironmentDeclarationProvenance,
): EnvironmentDeclaration[] {
  const values: EnvironmentDeclaration[] = [];
  let envIndent: number | undefined;
  let offset = 0;
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    const indent = indentation(line);
    if (/^env\s*:\s*(?:#.*)?$/.test(trimmed)) envIndent = indent;
    else if (envIndent !== undefined && trimmed && !trimmed.startsWith('#')) {
      if (indent <= envIndent) envIndent = undefined;
      else {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*(?:#.*)?$/
          .exec(trimmed);
        const value = match?.[2] === undefined
          ? undefined : scalarValue(match[2]);
        if (match?.[1] && value !== undefined)
          values.push(...declaration(
            match[1], value, provenance, filePath,
            offset + valueOffset(line, value, line.indexOf(':') + 1),
          ));
      }
    }
    offset += line.length + 1;
  }
  return values;
}

function snapshotDeclarations(
  filePath: string,
  text: string,
): EnvironmentDeclaration[] {
  const name = filePath.split('/').at(-1);
  if (name === 'nodemon.json') return jsonDeclarations(filePath, text);
  if (name === '.env') return dotenvDeclarations(filePath, text);
  if (name === 'manifest.yml')
    return yamlDeclarations(filePath, text, 'env_declaration_manifest');
  return name === 'mta.yaml'
    ? yamlDeclarations(filePath, text, 'env_declaration_mta') : [];
}

function compareDeclaration(
  left: EnvironmentDeclaration,
  right: EnvironmentDeclaration,
): number {
  const leftKey = `${left.key}\0${left.sourceFile}\0${left.startOffset}`;
  const rightKey = `${right.key}\0${right.sourceFile}\0${right.startOffset}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function parsedDeclaration(
  value: unknown,
): EnvironmentDeclaration | undefined {
  const item = record(value);
  if (!item || typeof item.key !== 'string'
    || !allowedKeys.has(item.key)
    || typeof item.value !== 'string' || item.value.length === 0
    || item.value.length > environmentValueLimit
    || hasControlCharacter(item.value)
    || dynamicEnvironmentValue.test(item.value)
    || typeof item.provenance !== 'string'
    || !allowedProvenance.has(
      item.provenance as EnvironmentDeclarationProvenance,
    )
    || typeof item.sourceFile !== 'string' || item.sourceFile.length === 0
    || !Number.isInteger(item.startOffset) || Number(item.startOffset) < 0
    || !Number.isInteger(item.endOffset)
    || Number(item.endOffset) <= Number(item.startOffset)) return undefined;
  return item as unknown as EnvironmentDeclaration;
}

function countsValid(
  item: Record<string, unknown>,
  declarations: EnvironmentDeclaration[],
): boolean {
  return item.recordCap === ENVIRONMENT_DECLARATION_RECORD_CAP
    && Number.isInteger(item.total) && Number(item.total) >= 0
    && Number.isInteger(item.shown) && Number(item.shown) >= 0
    && Number.isInteger(item.omitted) && Number(item.omitted) >= 0
    && Number(item.shown) + Number(item.omitted) === Number(item.total)
    && Number(item.shown) === declarations.length
    && declarations.length <= ENVIRONMENT_DECLARATION_RECORD_CAP;
}

function statusValid(
  item: Record<string, unknown>,
  declarations: EnvironmentDeclaration[],
): boolean {
  const distinct = new Map<string, Set<string>>();
  for (const value of declarations) {
    const values = distinct.get(value.key) ?? new Set<string>();
    values.add(value.value);
    distinct.set(value.key, values);
  }
  const ambiguous = [...distinct.values()].some((values) => values.size > 1);
  if (item.status === 'not_applicable')
    return item.reason === null && item.total === 0;
  if (item.status === 'complete')
    return item.reason === null && item.total === item.shown
      && Number(item.total) > 0 && !ambiguous;
  if (item.status === 'ambiguous')
    return item.reason === 'environment_declaration_values_conflict'
      && ambiguous && item.omitted === 0;
  return item.status === 'incomplete'
    && item.reason === 'environment_declaration_record_cap_exceeded'
    && Number(item.omitted) > 0;
}

export function parseEnvironmentDeclarationsFact(
  value: unknown,
): EnvironmentDeclarationsFact | undefined {
  const item = record(parseJson(value));
  if (!item || item.schema !== ENVIRONMENT_DECLARATIONS_SCHEMA
    || !Array.isArray(item.declarations)) return undefined;
  const declarations = item.declarations.flatMap((entry) => {
    const parsed = parsedDeclaration(entry);
    return parsed ? [parsed] : [];
  });
  if (declarations.length !== item.declarations.length
    || !countsValid(item, declarations)
    || !statusValid(item, declarations)) return undefined;
  const identities = declarations.map((entry) =>
    `${entry.key}\0${entry.sourceFile}\0${entry.startOffset}\0${entry.endOffset}`);
  if (new Set(identities).size !== identities.length) return undefined;
  return { ...item, declarations } as unknown as EnvironmentDeclarationsFact;
}

export function collectEnvironmentDeclarations(
  sources: RepositorySourceContext,
): EnvironmentDeclarationsFact {
  const all = sources.entries().flatMap((snapshot) =>
    snapshotDeclarations(snapshot.filePath, snapshot.text))
    .sort(compareDeclaration);
  const values = new Set(all.map((item) => `${item.key}\0${item.value}`));
  const ambiguous = EVENT_ENVIRONMENT_KEY_ALLOWLIST.some((key) =>
    [...values].filter((value) => value.startsWith(`${key}\0`)).length > 1);
  const declarations = all.slice(0, ENVIRONMENT_DECLARATION_RECORD_CAP);
  return {
    schema: ENVIRONMENT_DECLARATIONS_SCHEMA,
    status: ambiguous
      ? 'ambiguous'
      : all.length > ENVIRONMENT_DECLARATION_RECORD_CAP
        ? 'incomplete'
        : all.length > 0 ? 'complete' : 'not_applicable',
    reason: ambiguous
      ? 'environment_declaration_values_conflict'
      : all.length > ENVIRONMENT_DECLARATION_RECORD_CAP
        ? 'environment_declaration_record_cap_exceeded' : null,
    recordCap: ENVIRONMENT_DECLARATION_RECORD_CAP,
    total: all.length,
    shown: declarations.length,
    omitted: Math.max(0, all.length - declarations.length),
    declarations,
  };
}

export function emptyEnvironmentDeclarations(): EnvironmentDeclarationsFact {
  return {
    schema: ENVIRONMENT_DECLARATIONS_SCHEMA,
    status: 'not_applicable',
    reason: null,
    recordCap: ENVIRONMENT_DECLARATION_RECORD_CAP,
    total: 0,
    shown: 0,
    omitted: 0,
    declarations: [],
  };
}
