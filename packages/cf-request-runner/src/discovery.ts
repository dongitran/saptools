// cspell:words Insertable apos
import {
  fetchRemoteCdsServicesFromTarget,
  fetchXsuaaTokenFromTarget,
} from './cfClient.js';

export interface DiscoveredApiEntity {
  readonly name: string;
  readonly methods: readonly string[];
  readonly schema: unknown;
  readonly path: string;
}

export interface ApiCatalogDiscoveryOptions {
  readonly appId: string;
  readonly baseUrl: string;
  readonly cfHomeDir?: string | undefined;
  readonly token?: string | undefined;
  readonly log: (message: string) => void;
  readonly onDeepDiscoveryStart: () => void;
}

const API_METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;
const READ_METHODS = ['GET'] as const;
const ACTION_METHODS = ['POST'] as const;
const DISCOVERY_TIMEOUT_MS = 5000;
const BEARER_AUTH_SCHEME = /^Bearer\s+/iu;

interface XmlNode {
  readonly attributes: string;
  readonly body: string;
}

type ResolvedApiCatalogDiscoveryOptions = Omit<ApiCatalogDiscoveryOptions, 'token'> & {
  readonly token: string | null;
};

export interface ApiCatalogDiscoveryResult {
  readonly entities: readonly DiscoveredApiEntity[];
  readonly token: string | null;
}

export async function discoverApiEntities(
  options: ApiCatalogDiscoveryOptions
): Promise<readonly DiscoveredApiEntity[]> {
  return (await discoverApiEntitiesWithToken(options)).entities;
}

export async function discoverApiEntitiesWithToken(
  options: ApiCatalogDiscoveryOptions
): Promise<ApiCatalogDiscoveryResult> {
  const resolvedOptions = await withResolvedDiscoveryToken(options);
  let entities = await discoverRootEntities(resolvedOptions);
  if (entities.length === 0) {
    entities = await discoverCdsEntities(resolvedOptions);
  }
  if (entities.length === 0) {
    return { entities: [], token: resolvedOptions.token };
  }
  resolvedOptions.log(`Attempting deep discovery on ${String(entities.length)} root endpoints...`);
  resolvedOptions.onDeepDiscoveryStart();
  const expanded = await expandEntities(resolvedOptions, entities);
  resolvedOptions.log(`Deep discovery complete. Found ${String(expanded.length)} total endpoints.`);
  return { entities: expanded, token: resolvedOptions.token };
}

async function withResolvedDiscoveryToken(
  options: ApiCatalogDiscoveryOptions
): Promise<ResolvedApiCatalogDiscoveryOptions> {
  const token = options.token ?? await fetchXsuaaTokenFromTarget({
    appName: options.appId,
    cfHomeDir: options.cfHomeDir,
  });
  return { ...options, token };
}

async function discoverRootEntities(
  options: ResolvedApiCatalogDiscoveryOptions
): Promise<readonly DiscoveredApiEntity[]> {
  try {
    const token = options.token;

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token !== null && token !== '') {
      headers['Authorization'] = normalizeBearerToken(token);
    }

    const response = await fetch(buildEndpointUrl(options.baseUrl, '/'), {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      const data = await response.json();
      return parseRootCatalog(data);
    }
    return [];
  } catch (error) {
    options.log(`Failed to discover APIs from root endpoint: ${errorMessage(error)}`);
    return [];
  }
}

function parseRootCatalog(value: unknown): readonly DiscoveredApiEntity[] {
  if (!isRecord(value)) { return []; }
  const endpoints = value['endpoints'];
  if (Array.isArray(endpoints) && endpoints.length > 0) {
    return endpoints.flatMap((endpoint) => rootEntityFromEndpoint(endpoint));
  }
  const entries = value['value'];
  if (!Array.isArray(entries) || entries.length === 0) { return []; }
  return entries.flatMap((entry) => rootEntityFromServiceDocumentEntry(entry));
}

function rootEntityFromEndpoint(endpoint: unknown): readonly DiscoveredApiEntity[] {
  if (!isRecord(endpoint)) { return []; }
  const path = readNonEmptyString(endpoint['path']);
  if (path === undefined) { return []; }
  const name = readNonEmptyString(endpoint['name']) ?? fallbackNameFromPath(path);
  return [createEntity(name, path)];
}

function rootEntityFromServiceDocumentEntry(entry: unknown): readonly DiscoveredApiEntity[] {
  if (!isRecord(entry)) { return []; }
  const url = readNonEmptyString(entry['url']);
  const name = readNonEmptyString(entry['name']);
  const path = url === undefined ? name : `/${stripLeadingSlashes(url)}`;
  if (path === undefined) { return []; }
  return [createEntity(name ?? fallbackNameFromPath(path), path)];
}

function fallbackNameFromPath(path: string): string {
  const normalizedPath = path.replace(/[^a-zA-Z0-9]/g, '');
  return normalizedPath === '' ? 'Unknown' : normalizedPath;
}

async function discoverCdsEntities(
  options: Pick<ApiCatalogDiscoveryOptions, 'appId' | 'cfHomeDir' | 'log'>
): Promise<readonly DiscoveredApiEntity[]> {
  options.log(
    `Warning: No API entities discovered remotely from root endpoint for ${options.appId}. Attempting fallback via CF SSH remote .cds scan...`
  );
  try {
    const content = await fetchRemoteCdsServicesFromTarget({
      appName: options.appId,
      cfHomeDir: options.cfHomeDir,
    });
    const entities = typeof content === 'string' ? parseCdsServices(content) : [];
    if (entities.length > 0) {
      options.log(`Discovered ${String(entities.length)} entities via remote CF SSH scan.`);
    }
    return entities;
  } catch (error) {
    options.log(`CF SSH fallback failed: ${errorMessage(error)}`);
    return [];
  }
}

export function parseCdsServices(content: string): readonly DiscoveredApiEntity[] {
  const entities: DiscoveredApiEntity[] = [];
  const discovered = new Set<string>();
  const services = /service\s+([A-Za-z0-9_]+)/g;
  let match = services.exec(content);
  while (match !== null) {
    const name = match[1] ?? '';
    if (name !== '' && !discovered.has(name)) {
      discovered.add(name);
      const path = readCdsPathAfterService(content, match.index + match[0].length)
        ?? readCdsPathBeforeService(content, match.index)
        ?? defaultCdsServicePath(name);
      entities.push(createEntity(name, path));
    }
    match = services.exec(content);
  }
  return entities;
}

function readCdsPathAfterService(content: string, serviceNameEndIdx: number): string | undefined {
  const serviceHeaderEndIdx = content.indexOf('{', serviceNameEndIdx);
  const endIdx = serviceHeaderEndIdx === -1
    ? Math.min(content.length, serviceNameEndIdx + 300)
    : serviceHeaderEndIdx;
  return readCdsPathAnnotation(content.slice(serviceNameEndIdx, endIdx));
}

function readCdsPathBeforeService(content: string, serviceStartIdx: number): string | undefined {
  return readTrailingCdsPathAnnotation(content.slice(0, serviceStartIdx).trimEnd());
}

function readCdsPathAnnotation(source: string): string | undefined {
  const grouped = /@\(\s*path\s*:\s*['"]([^'"]+)['"]\s*\)/u.exec(source);
  if (grouped?.[1] !== undefined) { return grouped[1]; }
  return /@path\s*:\s*['"]([^'"]+)['"]/u.exec(source)?.[1];
}

function readTrailingCdsPathAnnotation(source: string): string | undefined {
  const grouped = /@\(\s*path\s*:\s*['"]([^'"]+)['"]\s*\)\s*$/u.exec(source);
  if (grouped?.[1] !== undefined) { return grouped[1]; }
  return /@path\s*:\s*['"]([^'"]+)['"]\s*$/u.exec(source)?.[1];
}

function defaultCdsServicePath(name: string): string {
  return `/odata/v4/${name.replace(/Service$/, '').toLowerCase()}`;
}

async function expandEntities(
  options: ResolvedApiCatalogDiscoveryOptions,
  entities: readonly DiscoveredApiEntity[]
): Promise<readonly DiscoveredApiEntity[]> {
  const token = options.token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token !== null && token !== '') {
    headers['Authorization'] = normalizeBearerToken(token);
  }

  const results = await Promise.allSettled(
    entities.map(async (entity): Promise<readonly DiscoveredApiEntity[]> =>
      await expandEntity(options.baseUrl, entity, headers)
    )
  );

  const expanded: DiscoveredApiEntity[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') { expanded.push(...result.value); }
  }
  return expanded.length > 0 ? expanded : entities;
}

async function expandEntity(
  baseUrl: string,
  entity: DiscoveredApiEntity,
  headers: Readonly<Record<string, string>>
): Promise<readonly DiscoveredApiEntity[]> {
  if (entity.path === '' || entity.path === '/') { return [entity]; }
  const metadataEntities = await fetchMetadataEntities(baseUrl, entity, headers);
  if (metadataEntities.length > 0) { return metadataEntities; }
  return await fetchServiceDocumentEntities(baseUrl, entity, headers);
}

async function fetchMetadataEntities(
  baseUrl: string,
  entity: DiscoveredApiEntity,
  headers: Readonly<Record<string, string>>
): Promise<readonly DiscoveredApiEntity[]> {
  try {
    const response = await fetch(buildEndpointUrl(baseUrl, entity.path, '$metadata'), {
      headers: { ...headers, Accept: 'application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) { return []; }
    return parseODataMetadata(await response.text(), entity.path, entity.name);
  } catch {
    return [];
  }
}

async function fetchServiceDocumentEntities(
  baseUrl: string,
  entity: DiscoveredApiEntity,
  headers: Readonly<Record<string, string>>
): Promise<readonly DiscoveredApiEntity[]> {
  try {
    const response = await fetch(buildEndpointUrl(baseUrl, entity.path), {
      headers,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) { return [entity]; }
    const data = await response.json();
    const subEntities = parseSubEntities(data, entity);
    return subEntities.length > 0 ? subEntities : [entity];
  } catch {
    return [entity];
  }
}

export function parseODataMetadata(
  metadataXml: string,
  servicePath: string,
  serviceName: string
): readonly DiscoveredApiEntity[] {
  const externalAnnotationsByEntity = collectExternalAnnotations(metadataXml);
  return [
    ...parseEntitySetMetadata(metadataXml, servicePath, serviceName, externalAnnotationsByEntity),
    ...parseOperationImports(metadataXml, 'FunctionImport', servicePath, serviceName, READ_METHODS),
    ...parseOperationImports(metadataXml, 'ActionImport', servicePath, serviceName, ACTION_METHODS),
  ];
}

function parseEntitySetMetadata(
  metadataXml: string,
  servicePath: string,
  serviceName: string,
  externalAnnotationsByEntity: ReadonlyMap<string, readonly string[]>
): readonly DiscoveredApiEntity[] {
  const entities: DiscoveredApiEntity[] = [];
  for (const node of findXmlNodes(metadataXml, 'EntitySet')) {
    const name = readXmlAttribute(node.attributes, 'Name');
    if (name === undefined || name === '') { continue; }
    const metadataSource = [
      node.body,
      ...(externalAnnotationsByEntity.get(name) ?? []),
    ].join('\n');
    entities.push(createEntity(
      `${serviceName} / ${name}`,
      joinEndpointPath(servicePath, name),
      entityMethodsFromMetadata(metadataSource),
    ));
  }
  return entities;
}

function collectExternalAnnotations(metadataXml: string): ReadonlyMap<string, readonly string[]> {
  const annotationsByEntity = new Map<string, string[]>();
  for (const node of findXmlNodes(metadataXml, 'Annotations')) {
    const target = readXmlAttribute(node.attributes, 'Target');
    const entityName = target === undefined ? undefined : entityNameFromAnnotationTarget(target);
    if (entityName === undefined || entityName === '') { continue; }
    const annotations = annotationsByEntity.get(entityName) ?? [];
    annotations.push(node.body);
    annotationsByEntity.set(entityName, annotations);
  }
  return annotationsByEntity;
}

function entityNameFromAnnotationTarget(target: string): string | undefined {
  const slashSegment = target.split('/').pop();
  const finalSegment = slashSegment?.split('.').pop();
  return finalSegment === '' ? undefined : finalSegment;
}

function parseOperationImports(
  metadataXml: string,
  tagName: 'FunctionImport' | 'ActionImport',
  servicePath: string,
  serviceName: string,
  methods: readonly string[]
): readonly DiscoveredApiEntity[] {
  const entities: DiscoveredApiEntity[] = [];
  for (const node of findXmlNodes(metadataXml, tagName)) {
    const name = readXmlAttribute(node.attributes, 'Name');
    if (name === undefined || name === '') { continue; }
    entities.push(createEntity(`${serviceName} / ${name}`, joinEndpointPath(servicePath, name), methods));
  }
  return entities;
}

function entityMethodsFromMetadata(entityBody: string): readonly string[] {
  return API_METHODS.filter((method) => capabilityAllowsMethod(entityBody, method));
}

function capabilityAllowsMethod(entityBody: string, method: string): boolean {
  if (method === 'POST') {
    return !hasFalseCapability(entityBody, 'InsertRestrictions', 'Insertable');
  }
  if (method === 'PATCH') {
    return !hasFalseCapability(entityBody, 'UpdateRestrictions', 'Updatable');
  }
  if (method === 'DELETE') {
    return !hasFalseCapability(entityBody, 'DeleteRestrictions', 'Deletable');
  }
  return true;
}

function hasFalseCapability(entityBody: string, restrictionName: string, propertyName: string): boolean {
  return findXmlNodes(entityBody, 'Annotation').some((annotation) => {
    const term = readXmlAttribute(annotation.attributes, 'Term') ?? '';
    return term.endsWith(restrictionName) && hasFalsePropertyValue(annotation.body, propertyName);
  });
}

function hasFalsePropertyValue(source: string, propertyName: string): boolean {
  return findXmlNodes(source, 'PropertyValue').some((propertyValue) =>
    readXmlAttribute(propertyValue.attributes, 'Property') === propertyName
    && readXmlAttribute(propertyValue.attributes, 'Bool') === 'false'
  );
}

function findXmlNodes(source: string, tagName: string): readonly XmlNode[] {
  const nodes: XmlNode[] = [];
  const qualifiedTagName = `(?:[A-Za-z_][\\w.-]*:)?${escapeRegExp(tagName)}`;
  const pattern = new RegExp(`<${qualifiedTagName}\\b([^>]*?)(?:\\s*/>|>([\\s\\S]*?)<\\/${qualifiedTagName}>)`, 'gu');
  let match = pattern.exec(source);
  while (match !== null) {
    nodes.push({ attributes: match[1] ?? '', body: match[2] ?? '' });
    match = pattern.exec(source);
  }
  return nodes;
}

function readXmlAttribute(attributes: string, name: string): string | undefined {
  const escapedName = escapeRegExp(name);
  const match = new RegExp(`\\b${escapedName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'u').exec(attributes);
  const value = match?.[2];
  return value === undefined ? undefined : decodeXmlText(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function buildEndpointUrl(baseUrl: string, endpointPath: string, suffix?: string): string {
  const normalizedBase = stripTrailingSlashes(baseUrl);
  const normalizedPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
  const normalizedSuffix = suffix === undefined ? '' : `/${stripLeadingSlashes(suffix)}`;
  return `${normalizedBase}${normalizedPath}${normalizedSuffix}`;
}

function joinEndpointPath(basePath: string, segment: string): string {
  const normalizedBase = stripTrailingSlashes(basePath);
  const normalizedSegment = stripLeadingSlashes(segment);
  return collapseRepeatedSlashes(`${normalizedBase}/${normalizedSegment}`);
}

function stripLeadingSlashes(value: string): string {
  let startIndex = 0;
  while (value[startIndex] === '/') { startIndex++; }
  return startIndex === 0 ? value : value.slice(startIndex);
}

function stripTrailingSlashes(value: string): string {
  let endIndex = value.length;
  while (endIndex > 0 && value[endIndex - 1] === '/') { endIndex--; }
  return endIndex === value.length ? value : value.slice(0, endIndex);
}

function collapseRepeatedSlashes(value: string): string {
  const parts: string[] = [];
  let previousWasSlash = false;
  for (const char of value) {
    if (char === '/') {
      if (!previousWasSlash) { parts.push(char); }
      previousWasSlash = true;
    } else {
      parts.push(char);
      previousWasSlash = false;
    }
  }
  return parts.join('');
}

export function parseSubEntities(
  value: unknown,
  parent: DiscoveredApiEntity
): readonly DiscoveredApiEntity[] {
  if (!isRecord(value) || !Array.isArray(value['value'])) { return []; }
  const entities: DiscoveredApiEntity[] = [];
  for (const rawEntry of value['value']) {
    if (!isRecord(rawEntry) || typeof rawEntry['name'] !== 'string') { continue; }
    if (rawEntry['name'] === '') { continue; }
    const path = typeof rawEntry['url'] === 'string' && rawEntry['url'] !== ''
      ? rawEntry['url']
      : rawEntry['name'];
    const joinedPath = joinEndpointPath(parent.path, path);
    entities.push(createEntity(`${parent.name} / ${rawEntry['name']}`, joinedPath));
  }
  return entities;
}

export function createEntity(
  name: string,
  path: string,
  methods: readonly string[] = API_METHODS
): DiscoveredApiEntity {
  return {
    name,
    methods,
    schema: { type: 'object', properties: {} },
    path,
  };
}

export function normalizeBearerToken(token: string): string {
  const trimmed = token.trim();
  return BEARER_AUTH_SCHEME.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') { return undefined; }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
