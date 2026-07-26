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

const remediation = [
  'service-flow index --workspace /workspace --force',
  'service-flow link --workspace /workspace --force',
].join('\n');
const CATEGORY_LIMIT = 24;

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

export function factLifecycleDiagnostic(
  db: Db,
  workspaceId?: number,
  phase: PackageFactPhase = 'pre_package',
): FactLifecycleDiagnostic | undefined {
  return schemaLifecycleDiagnostic(db)
    ?? currentFactLifecycleDiagnostic(db, workspaceId, phase);
}

export function schemaLifecycleDiagnostic(
  db: Db,
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
    remediation,
    currentSchemaVersion: currentSchema,
    requiredSchemaVersion: CURRENT_SCHEMA_VERSION,
  };
  const structureCategories = invalidSchemaStructureCategories(db);
  if (structureCategories.length > 0)
    return reindexDiagnostic(0, structureCategories);
  return undefined;
}

export function currentFactLifecycleDiagnostic(
  db: Db,
  workspaceId?: number,
  phase: PackageFactPhase = 'pre_package',
): FactLifecycleDiagnostic | undefined {
  const staleRepositories = oldAnalyzerCount(db, workspaceId);
  if (staleRepositories > 0)
    return reindexDiagnostic(staleRepositories, []);
  const jsonCategories = invalidFactJsonCategories(db, workspaceId);
  if (jsonCategories.length > 0)
    return reindexDiagnostic(0, jsonCategories);
  const semanticCategories = invalidFactSemanticCategories(
    db, workspaceId, phase,
  );
  if (semanticCategories.length === 0) return undefined;
  return reindexDiagnostic(0, semanticCategories);
}

type InvalidFactCategory =
  | FactJsonCategoryCount
  | FactSemanticCategoryCount
  | SchemaStructureCategoryCount;

function reindexDiagnostic(
  staleRepositories: number,
  categories: InvalidFactCategory[],
): FactLifecycleDiagnostic {
  const invalidFacts = categories.reduce((sum, item) => sum + item.count, 0);
  const shown = categories.slice(0, CATEGORY_LIMIT);
  return {
    severity: 'error',
    code: 'reindex_required',
    message: 'Current facts are stale or fail bounded semantic integrity checks; force index and link before tracing or rebuilding graph edges.',
    remediation,
    staleRepositoryCount: staleRepositories,
    invalidCallFactCount: invalidFacts,
    invalidFactCategories: shown,
    invalidFactCategoryCount: categories.length,
    shownInvalidFactCategoryCount: shown.length,
    omittedInvalidFactCategoryCount: categories.length - shown.length,
    requiredAnalyzerVersion: ANALYZER_VERSION,
  };
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
