import type { Db } from './connection.js';
import { ANALYZER_VERSION } from '../version.js';

export type FactJsonShape = 'object' | 'array';

export interface FactJsonInventoryItem {
  table: string;
  column: string;
  nullable: boolean;
  shape: FactJsonShape;
  consumers: readonly string[];
  repositoryJoin: string;
}

export interface FactJsonCategoryCount {
  category: string;
  count: number;
}

const directRepositoryJoin = 'JOIN repositories lifecycle_repo ON lifecycle_repo.id=fact.repo_id';

export const LINK_FACT_JSON_INVENTORY: readonly FactJsonInventoryItem[] = [
  {
    table: 'repositories',
    column: 'dependencies_json',
    nullable: false,
    shape: 'object',
    consumers: ['helper-package-linker'],
    repositoryJoin: '',
  },
  {
    table: 'repositories',
    column: 'package_public_surface_json',
    nullable: false,
    shape: 'object',
    consumers: ['package-import-symbol-resolver'],
    repositoryJoin: '',
  },
  {
    table: 'handler_methods',
    column: 'decorator_resolution_json',
    nullable: false,
    shape: 'object',
    consumers: ['implementation-linker', 'trace-selector'],
    repositoryJoin:
      'JOIN handler_classes owner ON owner.id=fact.handler_class_id JOIN repositories lifecycle_repo ON lifecycle_repo.id=owner.repo_id',
  },
  {
    table: 'symbols',
    column: 'evidence_json',
    nullable: true,
    shape: 'object',
    consumers: ['symbol-call-resolver', 'implementation-linker'],
    repositoryJoin: directRepositoryJoin,
  },
  {
    table: 'symbol_calls',
    column: 'evidence_json',
    nullable: false,
    shape: 'object',
    consumers: ['package-import-symbol-resolver', 'event-subscription-linker'],
    repositoryJoin: directRepositoryJoin,
  },
  {
    table: 'outbound_calls',
    column: 'evidence_json',
    nullable: false,
    shape: 'object',
    consumers: ['cross-repository-linker', 'trace-engine'],
    repositoryJoin: directRepositoryJoin,
  },
  {
    table: 'outbound_calls',
    column: 'alias_chain_json',
    nullable: true,
    shape: 'array',
    consumers: ['cross-repository-linker', 'trace-engine'],
    repositoryJoin: directRepositoryJoin,
  },
  {
    table: 'service_bindings',
    column: 'placeholders_json',
    nullable: false,
    shape: 'array',
    consumers: ['cross-repository-linker', 'trace-engine'],
    repositoryJoin: directRepositoryJoin,
  },
  {
    table: 'service_bindings',
    column: 'helper_chain_json',
    nullable: true,
    shape: 'array',
    consumers: ['cross-repository-linker', 'trace-engine'],
    repositoryJoin: directRepositoryJoin,
  },
  {
    table: 'cds_requires',
    column: 'raw_json',
    nullable: false,
    shape: 'object',
    consumers: ['service-resolution'],
    repositoryJoin: directRepositoryJoin,
  },
] as const;

function repositoryPredicate(item: FactJsonInventoryItem): string {
  if (item.table === 'repositories') {
    return `fact.fact_analyzer_version=?
      AND (? IS NULL OR fact.workspace_id=?)`;
  }
  return `lifecycle_repo.fact_analyzer_version=?
    AND (? IS NULL OR lifecycle_repo.workspace_id=?)`;
}

function invalidJsonCount(
  db: Db,
  item: FactJsonInventoryItem,
  workspaceId: number | undefined,
): number {
  const nullClause = item.nullable
    ? `fact.${item.column} IS NOT NULL AND`
    : `fact.${item.column} IS NULL OR`;
  const row = db.prepare(`SELECT COUNT(*) count FROM ${item.table} fact
    ${item.repositoryJoin}
    WHERE ${repositoryPredicate(item)}
      AND (${nullClause} json_valid(fact.${item.column})=0)`).get(
    ANALYZER_VERSION, workspaceId, workspaceId,
  );
  return Number(row?.count ?? 0);
}

function wrongShapeCount(
  db: Db,
  item: FactJsonInventoryItem,
  workspaceId: number | undefined,
): number {
  const row = db.prepare(`SELECT COUNT(*) count FROM ${item.table} fact
    ${item.repositoryJoin}
    WHERE ${repositoryPredicate(item)}
      AND fact.${item.column} IS NOT NULL
      AND json_type(fact.${item.column})<>?`).get(
    ANALYZER_VERSION, workspaceId, workspaceId, item.shape,
  );
  return Number(row?.count ?? 0);
}

function category(
  item: FactJsonInventoryItem,
  suffix: string,
  count: number,
): FactJsonCategoryCount {
  return {
    category: `json_${item.table}_${item.column}_${suffix}`,
    count,
  };
}

export function invalidFactJsonCategories(
  db: Db,
  workspaceId?: number,
): FactJsonCategoryCount[] {
  const invalid = LINK_FACT_JSON_INVENTORY.map((item) =>
    category(item, 'invalid', invalidJsonCount(db, item, workspaceId)))
    .filter((item) => item.count > 0);
  if (invalid.length > 0) return invalid;
  return LINK_FACT_JSON_INVENTORY.map((item) =>
    category(item, 'wrong_shape', wrongShapeCount(db, item, workspaceId)))
    .filter((item) => item.count > 0);
}
