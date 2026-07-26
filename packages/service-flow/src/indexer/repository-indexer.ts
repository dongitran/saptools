import fs from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/connection.js';
import {
  clearRepoFacts,
  insertBindings,
  insertCalls,
  insertExecutableSymbols,
  insertHandler,
  insertGeneratedConstants,
  handlerMethodIsExecutable,
  insertRegistrations,
  insertSymbolCalls,
  insertRequires,
  insertService,
  type RepoRow,
} from '../db/repositories.js';
import { classifyRepository } from '../discovery/classify-repository.js';
import { parseCdsFile } from '../parsers/cds-parser.js';
import { parseDecorators } from '../parsers/decorator-parser.js';
import { parseHandlerRegistrations } from '../parsers/handler-registration-parser.js';
import {
  classifyOutboundCallsInSource,
  parseOutboundCalls,
} from '../parsers/outbound-call-parser.js';
import { parseExecutableSymbols } from '../parsers/symbol-parser.js';
import {
  generatedConstantFacts,
} from '../parsers/generated-constants-parser.js';
import {
  loadPackageJsonSnapshot,
} from '../parsers/package-json-parser.js';
import { parseServiceBindings } from '../parsers/service-binding-parser.js';
import { reconcileSourceFacts } from '../parsers/source-fact-reconciliation.js';
import {
  analyzeRepositoryPackageSurface,
  mergePackageSymbolEvidence,
} from '../parsers/package-surface-publication.js';
import type {
  PackagePublicSurfaceFact,
} from '../parsers/package-public-surface.js';
import { normalizePath } from '../utils/path-utils.js';
import { errorMessage } from '../utils/diagnostics.js';
import { sha256Text } from '../utils/hashing.js';
import { ANALYZER_VERSION } from '../version.js';
import {
  createPackageInvalidationBatch,
  finalizePackageTargetInvalidations,
  invalidatePackageTargetFacts,
  type PackageInvalidationBatch,
} from '../db/package-target-invalidation.js';
import {
  isPreparedRepositorySnapshotError,
  recordPreparedSnapshotFailure,
} from '../db/index-publication-failure.js';
import {
  loadRepositorySourceContext,
  type RepositorySourceContext,
  type SourceContextInstrumentation,
} from '../parsers/ts-project.js';
import {
  createImportedEventNameResolver,
} from '../parsers/event-name-import-resolution.js';
import {
  collectEnvironmentDeclarations,
  type EnvironmentDeclarationsFact,
} from '../parsers/environment-declarations.js';
import {
  createEventEnvironmentReferenceResolver,
} from '../parsers/event-environment-reference.js';
import { invalidateEventSurfaceFacts } from
  '../db/event-surface-invalidation.js';
import type { CdsServiceFact, GeneratedConstantFact, HandlerClassFact, HandlerRegistrationFact, OutboundCallFact, PackageFacts, ServiceBindingFact, ExecutableSymbolFact, SymbolCallFact } from '../types.js';
export interface IndexRepoResult {
  fileCount: number;
  diagnosticCount: number;
  skipped: boolean;
}
interface ParsedFacts {
  services: CdsServiceFact[];
  handlers: HandlerClassFact[];
  registrations: HandlerRegistrationFact[];
  bindings: ServiceBindingFact[];
  calls: OutboundCallFact[];
  symbols: ExecutableSymbolFact[];
  symbolCalls: SymbolCallFact[];
  generatedConstants: GeneratedConstantFact[];
  fileRecords: Array<{ relativePath: string; extension: string; sha256: string; sizeBytes: number }>;
}
export interface PreparedRepositoryIndex extends IndexRepoResult {
  repo: RepoRow;
  packageFacts?: PackageFacts;
  fingerprint?: string;
  kind?: string;
  parsed?: ParsedFacts;
  packagePublicSurface?: PackagePublicSurfaceFact;
  environmentDeclarations?: EnvironmentDeclarationsFact;
}
export async function indexRepository(
  db: Db,
  repo: RepoRow,
  force: boolean,
  instrumentation?: SourceContextInstrumentation,
): Promise<IndexRepoResult> {
  try {
    const prepared = await prepareRepositoryIndex(repo, force, instrumentation);
    if (prepared.skipped)
      return { fileCount: 0, diagnosticCount: 0, skipped: true };
    const outcome = db.transaction(() => {
      const batch = createPackageInvalidationBatch([prepared.repo.id]);
      const published = publishOneRepository(db, prepared, batch);
      if (published.ok) finalizePackageTargetInvalidations(db, batch);
      return published;
    });
    return outcome.ok
      ? {
          fileCount: prepared.fileCount,
          diagnosticCount: prepared.diagnosticCount,
          skipped: false,
        }
      : { fileCount: 0, diagnosticCount: 1, skipped: false };
  } catch (error) {
    recordIndexFailure(db, repo.id, error);
    return { fileCount: 0, diagnosticCount: 1, skipped: false };
  }
}
export async function prepareRepositoryIndex(
  repo: RepoRow,
  force: boolean,
  instrumentation?: SourceContextInstrumentation,
): Promise<PreparedRepositoryIndex> {
  const sourceFiles = await findSourceFiles(repo.absolute_path);
  const packageSnapshot = await loadPackageJsonSnapshot(repo.absolute_path, {
    strict: true,
    allowMissing: repo.package_name === null,
  });
  const packageFacts = packageSnapshot.facts;
  const sources = await loadRepositorySourceContext(
    repo.absolute_path, sourceFiles, instrumentation,
  );
  const fingerprint = repositoryFingerprint(
    sources, packageFacts, packageSnapshot.rawText,
  );
  if (!force && repo.fingerprint === fingerprint) return { repo, fileCount: 0, diagnosticCount: 0, skipped: true };
  const parsedFacts = await parseAllSourceFacts(repo.absolute_path, sources);
  const packageSurface = analyzeRepositoryPackageSurface(
    packageFacts, packageSnapshot.manifest, sources,
  );
  const parsed = {
    ...parsedFacts,
    symbols: mergePackageSymbolEvidence(parsedFacts.symbols, packageSurface),
  };
  return {
    repo,
    packageFacts,
    fingerprint,
    kind: await classifyRepository(repo.absolute_path, packageFacts),
    parsed,
    packagePublicSurface: packageSurface.surface,
    environmentDeclarations: collectEnvironmentDeclarations(sources),
    fileCount: sourceFiles.length,
    diagnosticCount: parsed.handlers.filter((handler) =>
      handler.hasHandlerDecorator
      && (handler.methods.length === 0
        || handler.methods.some((method) => !handlerMethodIsExecutable(method)))).length,
    skipped: false,
  };
}
export function publishPreparedRepositoryIndex(
  db: Db,
  prepared: PreparedRepositoryIndex,
  invalidations: PackageInvalidationBatch,
): void {
  if (prepared.skipped) return;
  if (!prepared.packageFacts || !prepared.parsed || !prepared.fingerprint
    || !prepared.kind || !prepared.packagePublicSurface
    || !prepared.environmentDeclarations)
    throw new Error('Prepared repository index is missing publication facts');
  const now = new Date().toISOString();
  const repoId = prepared.repo.id;
  const environmentJson = JSON.stringify(prepared.environmentDeclarations);
  invalidatePackageTargetFacts(
    db, repoId, prepared.packageFacts.packageName, invalidations,
  );
  invalidateEventSurfaceFacts(
    db, repoId, prepared.parsed.calls, environmentJson,
  );
  db.prepare(`UPDATE repositories SET package_name=?, package_version=?,
    dependencies_json=?,package_public_surface_json=?,
    environment_declarations_json=?,kind=?,index_status=?
    WHERE id=?`).run(
    prepared.packageFacts.packageName,
    prepared.packageFacts.packageVersion,
    JSON.stringify(prepared.packageFacts.dependencies),
    JSON.stringify(prepared.packagePublicSurface),
    environmentJson,
    prepared.kind,
    'indexing',
    repoId,
  );
  clearRepoFacts(db, repoId);
  insertRequires(db, repoId, prepared.packageFacts.cdsRequires);
  const fileStmt = db.prepare('INSERT INTO files(repo_id,relative_path,extension,sha256,size_bytes,last_indexed_at) VALUES(?,?,?,?,?,?) ON CONFLICT(repo_id,relative_path) DO UPDATE SET sha256=excluded.sha256,size_bytes=excluded.size_bytes,last_indexed_at=excluded.last_indexed_at');
  for (const file of prepared.parsed.fileRecords) fileStmt.run(repoId, file.relativePath, file.extension, file.sha256, file.sizeBytes, now);
  for (const service of prepared.parsed.services) insertService(db, repoId, service);
  for (const handler of prepared.parsed.handlers) insertHandler(db, repoId, handler);
  insertExecutableSymbols(db, repoId, prepared.parsed.symbols);
  insertSymbolCalls(db, repoId, prepared.parsed.symbolCalls);
  insertRegistrations(db, repoId, prepared.parsed.registrations);
  insertBindings(db, repoId, prepared.parsed.bindings);
  insertCalls(db, repoId, prepared.parsed.calls);
  insertGeneratedConstants(db, repoId, prepared.parsed.generatedConstants);
  db.prepare("UPDATE repositories SET last_indexed_at=?, index_status='indexed', error_count=0, fingerprint=?, fact_generation=COALESCE(fact_generation,0)+1, graph_stale_reason='facts_changed', graph_stale_at=?, fact_analyzer_version=? WHERE id=?").run(now, prepared.fingerprint, now, ANALYZER_VERSION, repoId);
}

export type RepositoryPublicationOutcome =
  | { ok: true }
  | { ok: false; error: unknown };

export function publishOneRepository(
  db: Db,
  prepared: PreparedRepositoryIndex,
  invalidations: PackageInvalidationBatch,
): RepositoryPublicationOutcome {
  try {
    db.transaction(() => withPublicationSavepoint(
      db,
      prepared.repo.id,
      () => publishPreparedRepositoryIndex(db, prepared, invalidations),
    ));
    return { ok: true };
  } catch (error) {
    recordIndexFailure(db, prepared.repo.id, error);
    return { ok: false, error };
  }
}

function withPublicationSavepoint<T>(
  db: Db,
  repoId: number,
  publish: () => T,
): T {
  const name = `service_flow_repository_${repoId}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = publish();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}

export function recordIndexFailure(db: Db, repoId: number, error: unknown): void {
  if (isPreparedRepositorySnapshotError(error)) {
    recordPreparedSnapshotFailure(db, repoId, error);
    return;
  }
  const message = errorMessage(error);
  db.prepare("UPDATE repositories SET index_status='failed', error_count=1 WHERE id=?").run(repoId);
  db.prepare(`DELETE FROM diagnostics WHERE repo_id=? AND (
    code IN ('index_failed_snapshot_preserved','source_read_failed')
    OR code GLOB 'invalid_prepared_repository_snapshot:*'
  )`).run(repoId);
  db.prepare('INSERT INTO diagnostics(repo_id,severity,code,message) VALUES(?,?,?,?)').run(repoId, 'error', 'source_read_failed', `Index failed before publication; previous facts and fingerprint were preserved. ${message}`);
}
async function parseAllSourceFacts(
  root: string,
  sources: RepositorySourceContext,
): Promise<ParsedFacts> {
  const facts: ParsedFacts = { services: [], handlers: [], registrations: [], bindings: [], calls: [], symbols: [], symbolCalls: [], generatedConstants: [], fileRecords: [] };
  for (const snapshot of sources.entries()) {
    const file = snapshot.filePath;
    facts.fileRecords.push({ relativePath: normalizePath(file), extension: path.extname(file), sha256: sha256Text(snapshot.text), sizeBytes: snapshot.sizeBytes });
    if (file.endsWith('.cds')) facts.services.push(...(await parseCdsFile(root, file, sources)));
    if (/\.[jt]s$/.test(file)) {
      const source = snapshot.sourceFile();
      facts.generatedConstants.push(...generatedConstantFacts(source, file));
      const classified = classifyOutboundCallsInSource(source, file, {
        importedEventNameResolver: createImportedEventNameResolver(
          sources, source, file,
        ),
        eventEnvironmentReferenceResolver:
          createEventEnvironmentReferenceResolver(sources, source, file),
      });
      facts.handlers.push(...(await parseDecorators(root, file, sources)));
      facts.registrations.push(...(await parseHandlerRegistrations(root, file, sources)));
      const bindings = await parseServiceBindings(root, file, sources);
      const symbolFacts = await parseExecutableSymbols(
        root, file, sources, classified,
      );
      const outboundCalls = await parseOutboundCalls(
        root, file, sources, classified, bindings,
      );
      const reconciled = reconcileSourceFacts(
        source, classified, bindings, outboundCalls,
        symbolFacts.symbols, symbolFacts.calls,
      );
      facts.bindings.push(...reconciled.bindings);
      facts.symbols.push(...reconciled.symbols);
      facts.symbolCalls.push(...reconciled.symbolCalls);
      facts.calls.push(...reconciled.outboundCalls);
    }
  }
  return facts;
}
async function findSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix = ''): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!['node_modules', 'dist', 'gen', 'coverage', '.git'].includes(e.name)) await walk(path.join(dir, e.name), rel);
      } else if (isRepositoryFactInput(e.name)
        && !isDefaultTestFile(rel)) out.push(rel);
    }
  }
  await walk(root);
  return out.sort();
}
function isRepositoryFactInput(name: string): boolean {
  return /\.(cds|ts|js)$/.test(name)
    || ['nodemon.json', '.env', 'mta.yaml', 'manifest.yml'].includes(name);
}
function isDefaultTestFile(relativeFile: string): boolean {
  const parts = relativeFile.split('/');
  if (parts.some((part) => ['test', 'tests', '__tests__'].includes(part))) return true;
  return /\.(test|spec)\.[jt]s$/.test(parts.at(-1) ?? '');
}
function repositoryFingerprint(
  sources: RepositorySourceContext,
  facts: PackageFacts,
  packageJsonText: string,
): string {
  const normalizedFacts = {
    analyzerVersion: ANALYZER_VERSION,
    packageName: facts.packageName,
    packageVersion: facts.packageVersion,
    dependencies: Object.fromEntries(Object.entries(facts.dependencies).sort()),
    cdsRequires: [...facts.cdsRequires].sort((a, b) => a.alias.localeCompare(b.alias)),
    scripts: Object.fromEntries(Object.entries(facts.scripts).sort()),
    includeTests: false,
    packageJsonHash: sha256Text(packageJsonText),
  };
  const entries: string[] = [`facts:${JSON.stringify(normalizedFacts)}`];
  for (const snapshot of sources.entries())
    entries.push(`${snapshot.filePath}:${sha256Text(snapshot.text)}`);
  return sha256Text(entries.join('\n'));
}
