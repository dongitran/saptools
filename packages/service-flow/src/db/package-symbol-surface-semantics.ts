import { ANALYZER_VERSION } from '../version.js';
import {
  PACKAGE_PUBLIC_SURFACE_RECORD_CAP,
  PACKAGE_PUBLIC_SURFACE_SCHEMA,
  type ExecutableBodyEligibility,
  type PackagePublicScope,
  type PackagePublicSurfaceFact,
  type PublicSurfaceTarget,
} from '../parsers/package-public-surface.js';
import {
  parsePackagePublicSurfaceFact,
} from '../parsers/package-fact-contract.js';
import type { Db } from './connection.js';

interface Exposure {
  entry: string;
  modulePath: string;
  publicName: string;
}

interface SymbolSidecar {
  body: ExecutableBodyEligibility;
  exposures: Exposure[];
}

interface SurfaceSymbol {
  id: number;
  repoId: number;
  carrierValid: boolean;
  sourceFile: string;
  kind: string;
  qualifiedName: string;
  startOffset: number;
  endOffset: number;
  evidence?: Record<string, unknown>;
}

interface SurfaceRepository {
  id: number;
  surface?: PackagePublicSurfaceFact;
  symbols: SurfaceSymbol[];
}

const bodyReasons = new Set([
  'body_present', 'declaration_only', 'ambient_declaration',
  'abstract_bodyless', 'overload_signature',
]);
const sidecarKeys = [
  'schema', 'recordCap', 'bodyEligibility', 'exposures',
  'exposureTotal', 'shownExposureCount', 'omittedExposureCount',
];
const bodyKeys = ['eligible', 'reason'];
const exposureKeys = ['entry', 'modulePath', 'publicName'];

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function bodyEligibility(
  value: unknown,
): ExecutableBodyEligibility | undefined {
  const body = record(value);
  if (!body || !exactKeys(body, bodyKeys)
    || typeof body.eligible !== 'boolean'
    || typeof body.reason !== 'string'
    || !bodyReasons.has(body.reason)
    || body.eligible !== (body.reason === 'body_present')) return undefined;
  return body as unknown as ExecutableBodyEligibility;
}

function exposure(value: unknown): Exposure | undefined {
  const item = record(value);
  if (!item || !exactKeys(item, exposureKeys)
    || !nonEmpty(item.entry) || !nonEmpty(item.modulePath)
    || !nonEmpty(item.publicName)
    || (item.entry !== '.' && !item.entry.startsWith('./'))) return undefined;
  return item as unknown as Exposure;
}

function exposureKey(value: Exposure): string {
  return `${value.entry}\0${value.modulePath}\0${value.publicName}`;
}

function parsedExposures(value: unknown): Exposure[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.flatMap((item) => {
    const parsed = exposure(item);
    return parsed ? [parsed] : [];
  });
  const keys = new Set(values.map(exposureKey));
  return values.length === value.length && keys.size === values.length
    ? values : undefined;
}

function sidecar(value: unknown): SymbolSidecar | undefined {
  const item = record(value);
  if (!item || !exactKeys(item, sidecarKeys)
    || item.schema !== PACKAGE_PUBLIC_SURFACE_SCHEMA
    || item.recordCap !== PACKAGE_PUBLIC_SURFACE_RECORD_CAP) return undefined;
  const body = bodyEligibility(item.bodyEligibility);
  const exposures = parsedExposures(item.exposures);
  if (!body || !exposures || exposures.length === 0
    || !sidecarCountsValid(item, exposures.length))
    return undefined;
  return { body, exposures };
}

function sidecarCountsValid(
  item: Record<string, unknown>,
  exposureCount: number,
): boolean {
  return exposureCount <= PACKAGE_PUBLIC_SURFACE_RECORD_CAP
    && item.exposureTotal === exposureCount
    && item.shownExposureCount === exposureCount
    && item.omittedExposureCount === 0;
}

function currentRepositories(
  db: Db,
  workspaceId?: number,
): SurfaceRepository[] {
  const rows = db.prepare(`SELECT id,package_name packageName,
    package_public_surface_json surfaceJson FROM repositories
    WHERE fact_analyzer_version=?
      AND (? IS NULL OR workspace_id=?)
    ORDER BY id`).all(ANALYZER_VERSION, workspaceId, workspaceId);
  return rows.flatMap((row) => {
    if (typeof row.id !== 'number') return [];
    const packageName = typeof row.packageName === 'string'
      ? row.packageName : null;
    const value = parseRecord(row.surfaceJson);
    return [{
      id: row.id,
      surface: value
        ? parsePackagePublicSurfaceFact(value, packageName)
        : undefined,
      symbols: [],
    }];
  });
}

function currentSymbols(
  db: Db,
  workspaceId?: number,
): SurfaceSymbol[] {
  const rows = db.prepare(`SELECT s.id,s.repo_id repoId,
    s.source_file sourceFile,s.kind,s.qualified_name qualifiedName,
    s.start_offset startOffset,s.end_offset endOffset,
    s.evidence_json evidenceJson
    FROM symbols s JOIN repositories r ON r.id=s.repo_id
    WHERE r.fact_analyzer_version=?
      AND (? IS NULL OR r.workspace_id=?)
    ORDER BY s.id`).all(ANALYZER_VERSION, workspaceId, workspaceId);
  return rows.flatMap(surfaceSymbol);
}

function surfaceSymbol(row: Record<string, unknown>): SurfaceSymbol[] {
  if (typeof row.id !== 'number' || typeof row.repoId !== 'number') return [];
  const carrierValid = validSymbolCarrier(row);
  return [{
    id: row.id,
    repoId: row.repoId,
    carrierValid,
    sourceFile: stringField(row.sourceFile),
    kind: stringField(row.kind),
    qualifiedName: stringField(row.qualifiedName),
    startOffset: numberField(row.startOffset),
    endOffset: numberField(row.endOffset),
    evidence: parseRecord(row.evidenceJson),
  }];
}

function validSymbolCarrier(row: Record<string, unknown>): boolean {
  return typeof row.sourceFile === 'string' && typeof row.kind === 'string'
    && typeof row.qualifiedName === 'string'
    && typeof row.startOffset === 'number'
    && typeof row.endOffset === 'number' && row.startOffset >= 0
    && row.endOffset > row.startOffset;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberField(value: unknown): number {
  return typeof value === 'number' ? value : -1;
}

function repositoryAudits(
  db: Db,
  workspaceId?: number,
): SurfaceRepository[] {
  const repositories = currentRepositories(db, workspaceId);
  const byId = new Map(repositories.map((item) => [item.id, item]));
  for (const symbol of currentSymbols(db, workspaceId))
    byId.get(symbol.repoId)?.symbols.push(symbol);
  return repositories;
}

function targetMatches(
  target: PublicSurfaceTarget,
  symbol: SurfaceSymbol,
): boolean {
  return target.sourceFile === symbol.sourceFile
    && target.kind === symbol.kind
    && target.qualifiedName === symbol.qualifiedName
    && target.startOffset === symbol.startOffset
    && target.endOffset === symbol.endOffset;
}

function bodyMatches(
  left: ExecutableBodyEligibility,
  right: ExecutableBodyEligibility,
): boolean {
  return left.eligible === right.eligible && left.reason === right.reason;
}

function scopeExposure(scope: PackagePublicScope): Exposure {
  return {
    entry: scope.entry,
    modulePath: scope.modulePath,
    publicName: scope.publicName,
  };
}

function exposureProofValid(
  repository: SurfaceRepository,
  symbol: SurfaceSymbol,
  proof: SymbolSidecar,
  value: Exposure,
): boolean {
  if (!repository.surface) return false;
  const scopes = repository.surface.scopes.filter((scope) =>
    exposureKey(scopeExposure(scope)) === exposureKey(value));
  if (scopes.length !== 1 || !scopes[0]) return false;
  const targets = scopes[0].targets.filter((target) =>
    targetMatches(target, symbol)
    && bodyMatches(target.bodyEligibility, proof.body));
  return targets.length === 1;
}

function symbolProof(
  repository: SurfaceRepository,
  symbol: SurfaceSymbol,
): SymbolSidecar | undefined {
  if (!symbol.carrierValid) return undefined;
  const value = symbol.evidence?.packagePublicSurface;
  if (value === undefined) return undefined;
  const proof = sidecar(value);
  if (!proof || !proof.exposures.every((item) =>
    exposureProofValid(repository, symbol, proof, item))) return undefined;
  return proof;
}

function invalidPresentSidecarCount(
  repository: SurfaceRepository,
): number {
  return repository.symbols.filter((symbol) =>
    symbol.evidence
    && Object.hasOwn(symbol.evidence, 'packagePublicSurface')
    && !symbolProof(repository, symbol)).length;
}

function targetProofCount(
  repository: SurfaceRepository,
  scope: PackagePublicScope,
  target: PublicSurfaceTarget,
): number {
  const expected = exposureKey(scopeExposure(scope));
  return repository.symbols.filter((symbol) => {
    if (!targetMatches(target, symbol)) return false;
    const proof = symbolProof(repository, symbol);
    return Boolean(proof && bodyMatches(proof.body, target.bodyEligibility)
      && proof.exposures.some((item) => exposureKey(item) === expected));
  }).length;
}

function missingTargetProofCount(
  repository: SurfaceRepository,
): number {
  if (!repository.surface) return 0;
  return repository.surface.scopes.reduce((scopeTotal, scope) =>
    scopeTotal + scope.targets.filter((target) =>
      targetProofCount(repository, scope, target) !== 1).length, 0);
}

export function invalidPackageSymbolSurfaceCount(
  db: Db,
  workspaceId?: number,
): number {
  return repositoryAudits(db, workspaceId).reduce(
    (total, repository) => total
      + invalidPresentSidecarCount(repository)
      + missingTargetProofCount(repository),
    0,
  );
}
