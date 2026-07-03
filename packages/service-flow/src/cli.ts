import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs/promises';
import pc from 'picocolors';
import { DEFAULT_IGNORES } from './config/defaults.js';
import {
  createWorkspaceConfig,
  loadWorkspaceConfig,
  saveWorkspaceConfig,
} from './config/workspace-config.js';
import { openDatabase, openReadOnlyDatabase } from './db/connection.js';
import {
  getWorkspace,
  listRepositories,
  repoByName,
  upsertRepository,
  upsertWorkspace,
} from './db/repositories.js';
import { discoverRepositories } from './discovery/discover-repositories.js';
import { parsePackageJson } from './parsers/package-json-parser.js';
import { classifyRepository } from './discovery/classify-repository.js';
import { indexWorkspace } from './indexer/workspace-indexer.js';
import { linkWorkspace } from './linker/cross-repo-linker.js';
import { trace } from './trace/trace-engine.js';
import { parseVars } from './trace/selectors.js';
import { renderTraceTable } from './output/table-output.js';
import { renderTraceJson, renderJson } from './output/json-output.js';
import { renderMermaid } from './output/mermaid-output.js';
import { VERSION } from './version.js';
async function init(
  workspace: string,
  options: { db?: string; ignore?: string[] },
): Promise<void> {
  const config = createWorkspaceConfig(
    workspace,
    options.db,
    options.ignore?.length ? options.ignore : [...DEFAULT_IGNORES],
  );
  const repos = await discoverRepositories(config.rootPath, config.ignore);
  await saveWorkspaceConfig(config);
  const db = openDatabase(config.dbPath);
  const workspaceId = upsertWorkspace(db, config.rootPath, config.dbPath);
  for (const repo of repos) {
    const pkg = await parsePackageJson(repo.absolutePath);
    const kind = await classifyRepository(repo.absolutePath, pkg);
    upsertRepository(db, workspaceId, {
      ...repo,
      packageName: pkg.packageName,
      packageVersion: pkg.packageVersion,
      dependencies: pkg.dependencies,
      kind,
    });
  }
  db.close();
  process.stdout.write(
    `Workspace: ${config.rootPath}\nDatabase: ${config.dbPath}\nRepositories: ${repos.length}\nIgnored: ${config.ignore.join(', ')}\nNext: service-flow index --workspace ${config.rootPath}\n`,
  );
}
async function withWorkspace<T>(
  workspace: string | undefined,
  fn: (
    db: ReturnType<typeof openDatabase>,
    workspaceId: number,
    rootPath: string,
  ) => Promise<T> | T,
): Promise<T> {
  const config = await loadWorkspaceConfig(workspace);
  const db = openDatabase(config.dbPath);
  try {
    const row = getWorkspace(db, config.rootPath);
    const workspaceId =
      row?.id ?? upsertWorkspace(db, config.rootPath, config.dbPath);
    return await fn(db, workspaceId, config.rootPath);
  } finally {
    db.close();
  }
}
async function withReadOnlyWorkspace<T>(
  workspace: string | undefined,
  fn: (db: ReturnType<typeof openDatabase>, workspaceId: number, rootPath: string) => Promise<T> | T,
): Promise<T> {
  const config = await loadWorkspaceConfig(workspace);
  const db = openReadOnlyDatabase(config.dbPath);
  try {
    const row = getWorkspace(db, config.rootPath);
    if (!row) throw new Error(`Workspace is not initialized in ${config.dbPath}`);
    return await fn(db, row.id, config.rootPath);
  } finally {
    db.close();
  }
}
function localServiceDiagnostics(db: ReturnType<typeof openDatabase>, strict: boolean): Array<Record<string, unknown>> {
  const rows = db.prepare(`SELECT e.status status,e.unresolved_reason reason,e.evidence_json evidenceJson FROM graph_edges e JOIN outbound_calls c ON e.from_kind='call' AND c.id=CAST(e.from_id AS INTEGER) WHERE c.call_type='local_service_call'`).all() as Array<{ status?: string; reason?: string | null; evidenceJson?: string }>;
  const implementationContext = rows.filter((row) => row.status === 'resolved' && String(row.evidenceJson ?? '').includes('implementation_context_caller_ownership')).length;
  const withoutOwnership = rows.filter((row) => row.reason === 'local_service_candidate_without_caller_ownership' || String(row.evidenceJson ?? '').includes('local_service_candidate_without_caller_ownership')).length;
  const unresolved = rows.filter((row) => row.status === 'unresolved').length;
  const outsideScope = rows.filter((row) => {
    if (row.status !== 'unresolved') return false;
    try {
      const evidence = JSON.parse(String(row.evidenceJson ?? '{}')) as { candidateCount?: unknown };
      return Number(evidence.candidateCount ?? 0) > 0;
    } catch {
      return false;
    }
  }).length;
  const out: Array<Record<string, unknown>> = [];
  if (withoutOwnership > 0) out.push({ severity: 'warning', code: 'local_service_candidate_without_caller_ownership', message: `Local service calls have operation candidates but no caller ownership evidence: ${withoutOwnership}` });
  if (outsideScope > 0) out.push({ severity: 'warning', code: 'local_service_candidates_outside_local_scope', message: `Local service calls found candidates outside same-repository scope: ${outsideScope}` });
  if (strict && unresolved > 0) out.push({ severity: 'warning', code: 'local_service_calls_unresolved', message: `Unresolved local service calls: ${unresolved}` });
  if (strict && implementationContext > 0) out.push({ severity: 'info', code: 'local_service_calls_resolved_by_implementation_context', message: `Local service calls resolved by implementation-context ownership: ${implementationContext}` });
  return out;
}

function parserQualityDiagnostics(db: ReturnType<typeof openDatabase>, strict: boolean): Array<Record<string, unknown>> {
  if (!strict) return [];
  const symbol = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) resolved, SUM(CASE WHEN status='unresolved' THEN 1 ELSE 0 END) unresolved FROM symbol_calls").get() as { total?: number; resolved?: number; unresolved?: number };
  const top = db.prepare("SELECT callee_expression calleeExpression,COUNT(*) count FROM symbol_calls WHERE status='unresolved' GROUP BY callee_expression ORDER BY count DESC,callee_expression LIMIT 5").all() as Array<Record<string, unknown>>;
  const dbq = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN query_entity IS NOT NULL THEN 1 ELSE 0 END) known, SUM(CASE WHEN query_entity IS NULL THEN 1 ELSE 0 END) unknown FROM outbound_calls WHERE call_type='local_db_query'").get() as { total?: number; known?: number; unknown?: number };
  const symbolTotal = Number(symbol.total ?? 0);
  const symbolUnresolved = Number(symbol.unresolved ?? 0);
  const queryTotal = Number(dbq.total ?? 0);
  const queryUnknown = Number(dbq.unknown ?? 0);
  return [
    { severity: 'info', code: 'strict_symbol_call_quality', message: 'Symbol-call quality aggregate', total: symbolTotal, resolved: Number(symbol.resolved ?? 0), unresolved: symbolUnresolved, unresolvedRatio: symbolTotal === 0 ? 0 : Number((symbolUnresolved / symbolTotal).toFixed(4)), topUnresolvedCallees: top },
    { severity: 'info', code: 'strict_db_query_quality', message: 'Local DB query quality aggregate', total: queryTotal, known: Number(dbq.known ?? 0), unknown: queryUnknown, unknownRatio: queryTotal === 0 ? 0 : Number((queryUnknown / queryTotal).toFixed(4)) },
  ];
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name('service-flow')
    .description(
      'Trace SAP CAP service-to-service flows across multi-repository workspaces',
    )
    .version(VERSION);
  program
    .command('init')
    .argument('<workspace>')
    .option('--db <path>')
    .option('--ignore <pattern...>')
    .action(
      (workspace: string, opts: { db?: string; ignore?: string[] }) =>
        void init(workspace, opts).catch(fail),
    );
  program
    .command('index')
    .option('--workspace <path>')
    .option('--repo <name>')
    .option('--force')
    .action(
      (opts: { workspace?: string; repo?: string; force?: boolean }) =>
        void withWorkspace(opts.workspace, async (db, workspaceId) => {
          const r = await indexWorkspace(db, workspaceId, {
            repo: opts.repo,
            force: Boolean(opts.force),
          });
          process.stdout.write(
            `Indexed ${r.indexedCount} repositories, skipped ${r.skippedCount}, ${r.fileCount} files, ${r.diagnosticCount} diagnostics\n`,
          );
        }).catch(fail),
    );
  program
    .command('link')
    .option('--workspace <path>')
    .option('--force')
    .action(
      (opts: { workspace?: string }) =>
        void withWorkspace(opts.workspace, (db, workspaceId) => {
          const r = linkWorkspace(db, workspaceId);
          process.stdout.write(
            `Linked ${r.edgeCount} edges: ${r.resolvedCount} remote resolved, ${r.unresolvedCount} remote unresolved, ${r.ambiguousCount} remote ambiguous, ${r.dynamicCount} dynamic, ${r.terminalCount} terminal, ${r.dependencyResolvedCount} dependency resolved, ${r.dependencyAmbiguousCount} dependency ambiguous, ${r.implementationResolvedCount} implementation resolved, ${r.implementationAmbiguousCount} implementation ambiguous, ${r.implementationUnresolvedCount} implementation unresolved\n`,
          );
        }).catch(fail),
    );
  program
    .command('trace')
    .option('--workspace <path>')
    .option('--repo <name>')
    .option('--operation <name>')
    .option('--service <path>')
    .option('--path <operationPath>')
    .option('--handler <name>')
    .option('--depth <n>', 'trace depth', '25')
    .option('--format <format>', 'table|json|mermaid', 'table')
    .option('--include-external')
    .option('--include-db')
    .option('--include-async')
    .option('--var <key=value>', 'dynamic variable', collect, [])
    .action(
      (opts: {
        workspace?: string;
        repo?: string;
        operation?: string;
        service?: string;
        path?: string;
        handler?: string;
        depth: string;
        format: string;
        includeExternal?: boolean;
        includeDb?: boolean;
        includeAsync?: boolean;
        var: string[];
      }) =>
        void withReadOnlyWorkspace(opts.workspace, (db) => {
          const result = trace(
            db,
            {
              repo: opts.repo,
              servicePath: opts.service,
              operation: opts.operation,
              operationPath: opts.path,
              handler: opts.handler,
            },
            {
              depth: Number(opts.depth),
              vars: parseVars(opts.var),
              includeExternal: Boolean(opts.includeExternal),
              includeDb: Boolean(opts.includeDb),
              includeAsync: Boolean(opts.includeAsync),
            },
          );
          process.stdout.write(
            opts.format === 'json'
              ? renderTraceJson(result)
              : opts.format === 'mermaid'
                ? renderMermaid(result)
                : renderTraceTable(result),
          );
        }).catch(fail),
    );
  const list = program.command('list');
  list
    .command('repos')
    .option('--workspace <path>')
    .action(
      (opts: { workspace?: string }) =>
        void withReadOnlyWorkspace(opts.workspace, (db) =>
          process.stdout.write(
            renderJson(
              listRepositories(db).map((r) => ({
                name: r.name,
                kind: r.kind,
                packageName: r.package_name,
              })),
            ),
          ),
        ).catch(fail),
    );
  list
    .command('services')
    .option('--workspace <path>')
    .option('--repo <name>')
    .action(
      (opts: { workspace?: string; repo?: string }) =>
        void withReadOnlyWorkspace(opts.workspace, (db) => {
          const repo = opts.repo ? repoByName(db, opts.repo) : undefined;
          if (opts.repo && !repo) {
            process.stdout.write(renderJson([{ severity: 'warning', code: 'selector_repo_not_found', message: `Repository selector not found: ${opts.repo}` }]));
            return;
          }
          const rows = db
            .prepare(
              'SELECT r.name repo,s.service_path servicePath,s.qualified_name qualifiedName FROM cds_services s JOIN repositories r ON r.id=s.repo_id WHERE (? IS NULL OR s.repo_id=?) ORDER BY r.name,s.service_path',
            )
            .all(repo?.id, repo?.id);
          process.stdout.write(renderJson(rows));
        }).catch(fail),
    );
  list
    .command('operations')
    .option('--workspace <path>')
    .option('--repo <name>')
    .option('--service <path>')
    .action(
      (opts: { workspace?: string; repo?: string; service?: string }) =>
        void withReadOnlyWorkspace(opts.workspace, (db) => {
          const repo = opts.repo ? repoByName(db, opts.repo) : undefined;
          if (opts.repo && !repo) {
            process.stdout.write(renderJson([{ severity: 'warning', code: 'selector_repo_not_found', message: `Repository selector not found: ${opts.repo}` }]));
            return;
          }
          const rows = db
            .prepare(
              'SELECT r.name repo,s.service_path servicePath,o.operation_name operation,o.operation_path path FROM cds_operations o JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id WHERE (? IS NULL OR s.repo_id=?) AND (? IS NULL OR s.service_path=?)',
            )
            .all(repo?.id, repo?.id, opts.service, opts.service);
          process.stdout.write(renderJson(rows));
        }).catch(fail),
    );
  list
    .command('calls')
    .option('--workspace <path>')
    .option('--repo <name>')
    .option('--operation <name>')
    .action(
      (opts: { workspace?: string; repo?: string; operation?: string }) =>
        void withReadOnlyWorkspace(opts.workspace, (db) => {
          const repo = opts.repo ? repoByName(db, opts.repo) : undefined;
          if (opts.repo && !repo) {
            process.stdout.write(renderJson([{ severity: 'warning', code: 'selector_repo_not_found', message: `Repository selector not found: ${opts.repo}` }]));
            return;
          }
          const rows = db
            .prepare(
              'SELECT r.name repo,c.call_type type,c.operation_path_expr path,c.source_file file,c.source_line line FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id WHERE (? IS NULL OR c.repo_id=?) AND (? IS NULL OR c.operation_path_expr=? OR c.operation_path_expr=? OR c.payload_summary LIKE ?)',
            )
            .all(
              repo?.id,
              repo?.id,
              opts.operation,
              opts.operation,
              opts.operation ? `/${opts.operation}` : undefined,
              opts.operation ? `%${opts.operation}%` : undefined,
            );
          process.stdout.write(renderJson(rows));
        }).catch(fail),
    );
  program
    .command('graph')
    .option('--workspace <path>')
    .option('--repo <name>')
    .option('--operation <name>')
    .option('--service <path>')
    .option('--path <operationPath>')
    .option('--format <format>', 'mermaid|json', 'mermaid')
    .option('--var <key=value>', 'dynamic variable', collect, [])
    .action(
      (opts: {
        workspace?: string;
        repo?: string;
        operation?: string;
        service?: string;
        path?: string;
        format: string;
        var: string[];
      }) =>
        void withReadOnlyWorkspace(opts.workspace, (db) => {
          const result = trace(
            db,
            {
              repo: opts.repo,
              operation: opts.operation,
              servicePath: opts.service,
              operationPath: opts.path,
            },
            {
              depth: 100,
              includeAsync: true,
              includeDb: true,
              includeExternal: true,
              vars: parseVars(opts.var),
            },
          );
          process.stdout.write(
            opts.format === 'json'
              ? renderTraceJson(result)
              : renderMermaid(result),
          );
        }).catch(fail),
    );
  const inspect = program.command('inspect');
  inspect
    .command('repo')
    .argument('<name>')
    .option('--workspace <path>')
    .action(
      (name: string, opts: { workspace?: string }) =>
        void withReadOnlyWorkspace(opts.workspace, (db) =>
          process.stdout.write(
            renderJson(repoByName(db, name) ?? { error: 'repo not found' }),
          ),
        ).catch(fail),
    );
  inspect
    .command('operation')
    .argument('<selector>')
    .option('--workspace <path>')
    .action(
      (selector: string, opts: { workspace?: string }) =>
        void withReadOnlyWorkspace(opts.workspace, (db) => {
          const rows = db
            .prepare(
              'SELECT * FROM cds_operations WHERE operation_name=? OR operation_path=?',
            )
            .all(selector, selector);
          process.stdout.write(renderJson(rows));
        }).catch(fail),
    );
  program
    .command('doctor')
    .option('--workspace <path>')
    .option('--strict')
    .action(
      (opts: { workspace?: string; strict?: boolean }) =>
        void withReadOnlyWorkspace(opts.workspace, (db) => {
          const diagnostics = db
            .prepare(
              'SELECT severity,code,message,source_file sourceFile,source_line sourceLine FROM diagnostics ORDER BY id',
            )
            .all() as Array<Record<string, unknown>>;
          const health = db
            .prepare(
              `SELECT 'info' severity,'entity_only_service' code,'CDS service has no action/function/event operations; this can be valid for entity-only services' message,s.source_file sourceFile,s.source_line sourceLine
               FROM cds_services s LEFT JOIN cds_operations o ON o.service_id=s.id WHERE o.id IS NULL AND ?
               UNION ALL
               SELECT 'warning','extend_service_unresolved_base','Extend service has no indexed local operations; verify base service resolution',s.source_file,s.source_line
               FROM cds_services s LEFT JOIN cds_operations o ON o.service_id=s.id WHERE o.id IS NULL AND s.is_extend=1 AND ?
               UNION ALL
               SELECT 'warning','handler_without_service','Repository has handlers but no CDS services',hc.source_file,hc.source_line
               FROM handler_classes hc JOIN repositories r ON r.id=hc.repo_id
               WHERE r.kind IN ('cap-service','mixed') AND NOT EXISTS (SELECT 1 FROM cds_services s WHERE s.repo_id=hc.repo_id)
               UNION ALL
               SELECT 'warning','search_index_empty','Search index is empty after indexing',NULL,NULL
               WHERE NOT EXISTS (SELECT 1 FROM search_index)
               UNION ALL
               SELECT 'error','foreign_key_violation','SQLite foreign_key_check reported integrity failures',NULL,NULL
               WHERE EXISTS (SELECT 1 FROM pragma_foreign_key_check)
               UNION ALL
               SELECT 'warning','legacy_schema_weaker_foreign_keys','Legacy table lacks fresh-schema foreign-key metadata; rebuild the database or re-run init/index in a new database',NULL,NULL
               WHERE (SELECT COUNT(*) FROM pragma_foreign_key_list('graph_edges'))=0 OR (SELECT COUNT(*) FROM pragma_foreign_key_list('index_runs'))=0 OR (SELECT COUNT(*) FROM pragma_foreign_key_list('diagnostics'))=0
               UNION ALL
               SELECT 'warning','implementation_candidates_rejected','Implementation candidates were rejected for ' || s.service_path || o.operation_path,o.source_file,o.source_line
               FROM graph_edges e
               JOIN cds_operations o ON o.id=CAST(e.from_id AS INTEGER)
               JOIN cds_services s ON s.id=o.service_id
               WHERE e.edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND e.status='unresolved' AND (? OR EXISTS (SELECT 1 FROM graph_edges remote WHERE remote.edge_type='REMOTE_CALL_RESOLVES_TO_OPERATION' AND remote.to_kind='operation' AND remote.to_id=e.from_id))
               UNION ALL
               SELECT 'warning','remote_target_without_implementation','Remote target operation has no implementation edge: ' || s.service_path || o.operation_path,o.source_file,o.source_line
               FROM graph_edges remote
               JOIN cds_operations o ON o.id=CAST(remote.to_id AS INTEGER)
               JOIN cds_services s ON s.id=o.service_id
               WHERE remote.edge_type='REMOTE_CALL_RESOLVES_TO_OPERATION' AND remote.to_kind='operation' AND NOT EXISTS (SELECT 1 FROM graph_edges impl WHERE impl.edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND impl.from_kind='operation' AND impl.from_id=remote.to_id) AND ?
               UNION ALL
               SELECT CASE WHEN ? THEN 'warning' ELSE 'error' END,'local_service_calls_all_unresolved','All local service calls are unresolved; verify local service alias parsing and linking',NULL,NULL
               WHERE EXISTS (SELECT 1 FROM outbound_calls WHERE call_type='local_service_call') AND NOT EXISTS (SELECT 1 FROM graph_edges e JOIN outbound_calls c ON e.from_kind='call' AND c.id=CAST(e.from_id AS INTEGER) WHERE c.call_type='local_service_call' AND e.status='resolved')
               UNION ALL
               SELECT 'error','local_service_accessor_misclassified','Entity accessor calls were indexed as /entities operations',source_file,source_line
               FROM outbound_calls WHERE call_type='local_service_call' AND operation_path_expr='/entities' AND (? OR 1)
               UNION ALL
               SELECT 'warning','outbound_calls_without_source_symbol','Outbound calls lack source symbol ownership: ' || COUNT(*),NULL,NULL
               FROM outbound_calls WHERE source_symbol_id IS NULL AND ? HAVING COUNT(*) >= 1
               UNION ALL
               SELECT 'warning','trace_scope_fell_back_to_file','Trace may fall back to source-file scope for calls without symbols',NULL,NULL
               WHERE EXISTS (SELECT 1 FROM outbound_calls WHERE source_symbol_id IS NULL) AND ?
               UNION ALL
               SELECT 'warning','graph_stale','Graph is stale after repository fact changes; run service-flow link',NULL,NULL
               WHERE EXISTS (SELECT 1 FROM repositories WHERE graph_stale_reason IS NOT NULL)
               UNION ALL
               SELECT 'warning','index_run_abandoned','Index run ' || id || ' started at ' || started_at || ' is still running after the 60 minute abandonment threshold',NULL,NULL
               FROM index_runs WHERE status='running' AND datetime(started_at) < datetime('now','-60 minutes')`,
            )
            .all(Boolean(opts.strict), Boolean(opts.strict), Boolean(opts.strict), Boolean(opts.strict), Boolean(opts.strict), Boolean(opts.strict), Boolean(opts.strict), Boolean(opts.strict)) as Array<Record<string, unknown>>;
          const localServiceHealth = localServiceDiagnostics(db, Boolean(opts.strict));
          const parserQualityHealth = parserQualityDiagnostics(db, Boolean(opts.strict));
          const allDiagnostics = [...diagnostics, ...health, ...localServiceHealth, ...parserQualityHealth];
          process.stdout.write(
            allDiagnostics.length
              ? renderJson(allDiagnostics)
              : `${pc.green('No diagnostics recorded')}\n`,
          );
        }).catch(fail),
    );
  program
    .command('clean')
    .option('--workspace <path>')
    .option('--db-only')
    .action(
      (opts: { workspace?: string; dbOnly?: boolean }) =>
        void (async () => {
          const config = await loadWorkspaceConfig(opts.workspace);
          const dbDir = path.resolve(path.dirname(config.dbPath));
          const workspaceRoot = path.resolve(config.rootPath);
          await fs.rm(config.dbPath, { force: true });
          if (!opts.dbOnly) {
            const marker = path.join(dbDir, '.service-flow-state');
            const dangerous = new Set([
              path.parse(dbDir).root,
              '/tmp',
              process.env.HOME ? path.resolve(process.env.HOME) : '',
              workspaceRoot,
            ]);
            let ownsState: boolean;
            try {
              ownsState = (await fs.stat(marker)).isFile();
            } catch {
              ownsState = false;
            }
            if (!ownsState || dangerous.has(dbDir))
              throw new Error(
                `Refusing to recursively delete unowned or dangerous state directory: ${dbDir}. Use --db-only to remove only the database file.`,
              );
            await fs.rm(dbDir, { recursive: true, force: true });
          }
          process.stdout.write('Cleaned service-flow state\n');
        })().catch(fail),
    );
  return program;
}
function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}
function fail(error: unknown): void {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
createProgram().parse(process.argv);
