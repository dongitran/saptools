import type { Db } from './connection.js';
import { CURRENT_SCHEMA_VERSION, schemaVersion } from './migrations.js';
import {
  invalidFactJsonCategories,
  type FactJsonCategoryCount,
} from './fact-json-inventory.js';
import {
  invalidFactSemanticCategories,
  type FactSemanticCategoryCount,
  type PackageFactPhase,
} from './current-fact-semantics.js';
import {
  invalidSchemaStructureCategories,
  type SchemaStructureCategoryCount,
} from './schema-structure.js';
import { ANALYZER_VERSION } from '../version.js';
import { invalidEventFactExamples } from './event-fact-semantics.js';

export type FactLifecycleCode =
  | 'schema_upgrade_required'
  | 'unsupported_future_schema'
  | 'reindex_required';

export interface FactLifecycleDiagnostic extends Record<string, unknown> {
  severity: 'error';
  code: FactLifecycleCode;
  message: string;
  remediation: string;
}

const CATEGORY_LIMIT = 24;
const EXAMPLE_LIMIT = 5;
const STALE_REPOSITORY_LIMIT = 8;

function count(db: Db, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params);
  return Number(row?.count ?? 0);
}

function oldAnalyzerCount(db: Db, workspaceId?: number): number {
  return count(db, `SELECT COUNT(*) count FROM repositories
    WHERE (? IS NULL OR workspace_id=?)
      AND (COALESCE(index_status,'pending')<>'indexed'
        OR COALESCE(fact_analyzer_version,'legacy')<>?)`,
  workspaceId, workspaceId, ANALYZER_VERSION);
}

function staleRepositoryExamples(
  db: Db,
  workspaceId?: number,
): Array<Record<string, unknown>> {
  return db.prepare(`SELECT id repositoryId,name repositoryName,
    index_status indexStatus,fact_analyzer_version factAnalyzerVersion,
    graph_stale_reason graphStaleReason
    FROM repositories
    WHERE (? IS NULL OR workspace_id=?)
      AND (COALESCE(index_status,'pending')<>'indexed'
        OR COALESCE(fact_analyzer_version,'legacy')<>?)
    ORDER BY name COLLATE BINARY,id LIMIT ?`).all(
    workspaceId, workspaceId, ANALYZER_VERSION, STALE_REPOSITORY_LIMIT,
  );
}

export function factLifecycleDiagnostic(
  db: Db,
  workspaceId?: number,
  phase: PackageFactPhase = 'pre_package',
): FactLifecycleDiagnostic | undefined {
  return schemaLifecycleDiagnostic(db, workspaceId)
    ?? currentFactLifecycleDiagnostic(db, workspaceId, phase);
}

export function schemaLifecycleDiagnostic(
  db: Db,
  workspaceId?: number,
): FactLifecycleDiagnostic | undefined {
  const currentSchema = schemaVersion(db);
  if (currentSchema > CURRENT_SCHEMA_VERSION) return {
    severity: 'error',
    code: 'unsupported_future_schema',
    message: `Database schema ${currentSchema} is newer than the supported schema ${CURRENT_SCHEMA_VERSION}; upgrade service-flow before reading this database.`,
    remediation: 'Install a service-flow version that supports this database schema.',
    currentSchemaVersion: currentSchema,
    supportedSchemaVersion: CURRENT_SCHEMA_VERSION,
  };
  if (currentSchema < CURRENT_SCHEMA_VERSION) return {
    severity: 'error',
    code: 'schema_upgrade_required',
    message: `Database schema ${currentSchema} must be upgraded to ${CURRENT_SCHEMA_VERSION} before this command can read current call-site facts.`,
    remediation: staleRemediation(db, workspaceId),
    currentSchemaVersion: currentSchema,
    requiredSchemaVersion: CURRENT_SCHEMA_VERSION,
  };
  const structureCategories = invalidSchemaStructureCategories(db);
  if (structureCategories.length > 0)
    return reindexDiagnostic(
      db, workspaceId, 0, structureCategories, 'pre_package', false,
    );
  return undefined;
}

export function currentFactLifecycleDiagnostic(
  db: Db,
  workspaceId?: number,
  phase: PackageFactPhase = 'pre_package',
): FactLifecycleDiagnostic | undefined {
  const staleRepositories = oldAnalyzerCount(db, workspaceId);
  if (staleRepositories > 0)
    return reindexDiagnostic(
      db, workspaceId, staleRepositories, [], phase,
    );
  const jsonCategories = invalidFactJsonCategories(db, workspaceId);
  if (jsonCategories.length > 0)
    return reindexDiagnostic(db, workspaceId, 0, jsonCategories, phase);
  const semanticCategories = invalidFactSemanticCategories(
    db, workspaceId, phase,
  );
  if (semanticCategories.length === 0) return undefined;
  return reindexDiagnostic(db, workspaceId, 0, semanticCategories, phase);
}

type InvalidFactCategory =
  | FactJsonCategoryCount
  | FactSemanticCategoryCount
  | SchemaStructureCategoryCount;

function reindexDiagnostic(
  db: Db,
  workspaceId: number | undefined,
  staleRepositories: number,
  categories: InvalidFactCategory[],
  phase: PackageFactPhase,
  examplesAllowed = true,
): FactLifecycleDiagnostic {
  const invalidFacts = categories.reduce((sum, item) => sum + item.count, 0);
  const shown = categories.slice(0, CATEGORY_LIMIT);
  const eventExamples = examplesAllowed
    ? invalidEventFactExamples(db, workspaceId, phase, EXAMPLE_LIMIT)
    : { total: 0, affectedRepositoryCount: 0, examples: [] };
  const examples = invalidFacts > 0 ? eventExamples.examples : [];
  const staleExamples = staleRepositories > 0
    ? staleRepositoryExamples(db, workspaceId) : [];
  const affectedRepositories = staleRepositories > 0
    ? staleRepositories : eventExamples.affectedRepositoryCount;
  return {
    severity: 'error',
    code: 'reindex_required',
    message: invalidFacts > 0
      ? 'Current facts fail bounded semantic integrity checks; inspect the offending rows before rebuilding graph edges.'
      : 'Current facts are stale; force index and link before tracing or rebuilding graph edges.',
    remediation: invalidFacts > 0
      ? invalidFactRemediation(db, workspaceId)
      : staleRemediation(db, workspaceId),
    staleRepositoryCount: staleRepositories,
    invalidCallFactCount: invalidFacts,
    invalidFactCategories: shown,
    invalidFactCategoryCount: categories.length,
    shownInvalidFactCategoryCount: shown.length,
    omittedInvalidFactCategoryCount: categories.length - shown.length,
    affectedRepositoryCount: affectedRepositories,
    staleRepositories: staleExamples,
    staleRepositoryExampleCount: staleRepositories,
    shownStaleRepositoryCount: staleExamples.length,
    omittedStaleRepositoryCount:
      Math.max(0, staleRepositories - staleExamples.length),
    workspaceRepositoryCount: repositoryCount(db, workspaceId),
    invalidFactExamples: examples,
    invalidFactExampleCount: eventExamples.total,
    shownInvalidFactExampleCount: examples.length,
    omittedInvalidFactExampleCount:
      Math.max(0, eventExamples.total - examples.length),
    requiredAnalyzerVersion: ANALYZER_VERSION,
  };
}

function workspacePath(db: Db, workspaceId?: number): string | undefined {
  if (workspaceId === undefined) return undefined;
  const row = db.prepare(
    'SELECT root_path rootPath FROM workspaces WHERE id=?',
  ).get(workspaceId);
  return typeof row?.rootPath === 'string' ? row.rootPath : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function workspaceArgument(db: Db, workspaceId?: number): string {
  const root = workspacePath(db, workspaceId);
  return root ? ` --workspace ${shellQuote(root)}` : '';
}

function staleRemediation(db: Db, workspaceId?: number): string {
  const workspace = workspaceArgument(db, workspaceId);
  return [
    `service-flow index${workspace} --force`,
    `service-flow link${workspace} --force`,
  ].join('\n');
}

function invalidFactRemediation(db: Db, workspaceId?: number): string {
  return `service-flow doctor${workspaceArgument(
    db, workspaceId,
  )} --strict --detail`;
}

function repositoryCount(db: Db, workspaceId?: number): number {
  return count(db, `SELECT COUNT(*) count FROM repositories
    WHERE (? IS NULL OR workspace_id=?)`, workspaceId, workspaceId);
}

export function assertWorkspaceLinkable(
  db: Db,
  workspaceId: number,
  phase: PackageFactPhase = 'pre_package',
): void {
  const diagnostic = factLifecycleDiagnostic(db, workspaceId, phase);
  if (!diagnostic) return;
  const categories = Array.isArray(diagnostic.invalidFactCategories)
    ? ` categories=${JSON.stringify(diagnostic.invalidFactCategories)}`
    : '';
  throw new Error(
    `${diagnostic.code}: ${diagnostic.message}${categories}\n${diagnostic.remediation}`,
  );
}
