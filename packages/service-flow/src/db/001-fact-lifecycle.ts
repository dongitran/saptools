import type { Db } from './connection.js';
import { CURRENT_SCHEMA_VERSION, schemaVersion } from './migrations.js';
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

function invalidCurrentFactCount(db: Db, workspaceId?: number): number {
  const outbound = count(db, `SELECT COUNT(*) count
    FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id
    WHERE (? IS NULL OR r.workspace_id=?) AND r.fact_analyzer_version=?
      AND (typeof(c.call_site_start_offset)<>'integer'
        OR typeof(c.call_site_end_offset)<>'integer'
        OR c.call_site_start_offset<0
        OR c.call_site_end_offset<=c.call_site_start_offset)`,
  workspaceId, workspaceId, ANALYZER_VERSION);
  const symbols = count(db, `SELECT COUNT(*) count
    FROM symbol_calls c JOIN repositories r ON r.id=c.repo_id
    WHERE (? IS NULL OR r.workspace_id=?)
      AND (c.call_role='legacy_unknown'
        OR (r.fact_analyzer_version=? AND (
          typeof(c.call_site_start_offset)<>'integer'
          OR typeof(c.call_site_end_offset)<>'integer'
          OR c.call_site_start_offset<0
          OR c.call_site_end_offset<=c.call_site_start_offset
          OR c.call_role NOT IN ('ordinary_call','event_subscribe_handler'))))`,
  workspaceId, workspaceId, ANALYZER_VERSION);
  return outbound + symbols;
}

export function factLifecycleDiagnostic(
  db: Db,
  workspaceId?: number,
): FactLifecycleDiagnostic | undefined {
  return schemaLifecycleDiagnostic(db)
    ?? currentFactLifecycleDiagnostic(db, workspaceId);
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
  return undefined;
}

export function currentFactLifecycleDiagnostic(
  db: Db,
  workspaceId?: number,
): FactLifecycleDiagnostic | undefined {
  const staleRepositories = oldAnalyzerCount(db, workspaceId);
  const invalidFacts = invalidCurrentFactCount(db, workspaceId);
  if (staleRepositories === 0 && invalidFacts === 0) return undefined;
  return {
    severity: 'error',
    code: 'reindex_required',
    message: 'Call-site facts are stale or lack typed roles and exact spans; force index and link before tracing or rebuilding graph edges.',
    remediation,
    staleRepositoryCount: staleRepositories,
    invalidCallFactCount: invalidFacts,
    requiredAnalyzerVersion: ANALYZER_VERSION,
  };
}

export function assertWorkspaceLinkable(db: Db, workspaceId: number): void {
  const diagnostic = factLifecycleDiagnostic(db, workspaceId);
  if (!diagnostic) return;
  throw new Error(`${diagnostic.code}: ${diagnostic.message}\n${diagnostic.remediation}`);
}
