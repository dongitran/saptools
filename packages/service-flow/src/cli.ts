import { Command } from 'commander';
import { DEFAULT_IGNORES } from './config/defaults.js';
import {
  createWorkspaceConfig,
  loadWorkspaceConfig,
  saveWorkspaceConfig,
} from './config/workspace-config.js';
import { openDatabase, openReadOnlyDatabase, type Db } from './db/connection.js';
import {
  getWorkspace,
  listRepositories,
  reposByName,
  type RepoRow,
  upsertRepository,
  upsertWorkspace,
} from './db/repositories.js';
import { discoverRepositories } from './discovery/discover-repositories.js';
import { parsePackageJson } from './parsers/package-json-parser.js';
import { classifyRepository } from './discovery/classify-repository.js';
import { indexWorkspace } from './indexer/workspace-indexer.js';
import { linkWorkspace } from './linker/cross-repo-linker.js';
import { doctorDiagnostics, linkUpgradeWarnings } from './cli/doctor.js';
import { trace } from './trace/trace-engine.js';
import {
  parseVars,
  selectorRepoAmbiguousDiagnostic,
} from './trace/selectors.js';
import { parseImplementationHint } from './trace/implementation-hints.js';
import { renderTraceTable } from './output/table-output.js';
import { renderTraceJson, renderJson } from './output/json-output.js';
import { renderDoctorDiagnostics } from './output/doctor-output.js';
import { renderMermaid } from './output/mermaid-output.js';
import { createStdoutWriter } from './output/000-stdout-policy.js';
import { VERSION } from './version.js';
import type { DynamicMode } from './types.js';
import { cleanWorkspaceState } from './cli/000-clean.js';

const stdout = createStdoutWriter(process.stdout, fail);

function writeStdout(value: string): void {
  stdout.write(value);
}

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
  writeStdout(
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
function selectRepository(db: Db, selector: string, workspaceId?: number): {
  repo?: RepoRow;
  diagnostic?: Record<string, unknown>;
} {
  const candidates = reposByName(db, selector, workspaceId);
  if (candidates.length === 1) return { repo: candidates[0] };
  if (candidates.length === 0) return {
    diagnostic: {
      severity: 'warning',
      code: 'selector_repo_not_found',
      message: `Repository selector not found: ${selector}`,
    },
  };
  return {
    diagnostic: selectorRepoAmbiguousDiagnostic(
      selector,
      candidates.map((repo) => ({
        id: repo.id,
        name: repo.name,
        packageName: repo.package_name ?? undefined,
      })),
    ),
  };
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
          writeStdout(
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
          const upgradeWarnings = linkUpgradeWarnings(db);
          writeStdout(
            `${upgradeWarnings.length ? `Warnings: ${upgradeWarnings.map((item) => String(item.code)).join(', ')}. Run service-flow doctor --strict for remediation.\n` : ''}Linked ${r.edgeCount} edges: ${r.remoteResolvedCount} remote operation calls resolved, ${r.localResolvedCount} local operation calls resolved, ${r.unresolvedCount} unresolved operation calls, ${r.ambiguousCount} ambiguous operation calls, ${r.dynamicCount} dynamic operation calls, ${r.terminalCount} terminal call edges, ${r.dependencyResolvedCount} dependency resolved, ${r.dependencyAmbiguousCount} dependency ambiguous, ${r.implementationResolvedCount} implementation resolved, ${r.implementationAmbiguousCount} implementation ambiguous, ${r.implementationUnresolvedCount} implementation unresolved\n`,
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
    .option('--implementation-repo <name>')
    .option('--implementation-hint <scope>', 'scoped implementation hint', collect, [])
    .option('--var <key=value>', 'dynamic variable', collect, [])
    .option('--dynamic-mode <mode>', 'strict|candidates|infer', 'strict')
    .option('--max-dynamic-candidates <n>', 'maximum dynamic candidates to show', '5')
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
        implementationRepo?: string;
        implementationHint: string[];
        var: string[];
        dynamicMode: string;
        maxDynamicCandidates: string;
      }) =>
        void withReadOnlyWorkspace(opts.workspace, (db, workspaceId) => {
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
              workspaceId,
              vars: parseVars(opts.var),
              includeExternal: Boolean(opts.includeExternal),
              includeDb: Boolean(opts.includeDb),
              includeAsync: Boolean(opts.includeAsync),
              implementationRepo: opts.implementationRepo,
              implementationHints: opts.implementationHint.map(parseImplementationHint),
              dynamicMode: parseDynamicMode(opts.dynamicMode),
              maxDynamicCandidates: parsePositiveInteger(opts.maxDynamicCandidates, 5),
            },
          );
          writeStdout(
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
        void withReadOnlyWorkspace(opts.workspace, (db, workspaceId) =>
          writeStdout(
            renderJson(
              listRepositories(db, workspaceId).map((r) => ({
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
        void withReadOnlyWorkspace(opts.workspace, (db, workspaceId) => {
          const selection = opts.repo
            ? selectRepository(db, opts.repo, workspaceId)
            : {};
          if (selection.diagnostic) {
            writeStdout(renderJson([selection.diagnostic]));
            return;
          }
          const repo = selection.repo;
          const rows = db
            .prepare(
              'SELECT r.name repo,s.service_path servicePath,s.qualified_name qualifiedName FROM cds_services s JOIN repositories r ON r.id=s.repo_id WHERE r.workspace_id=? AND (? IS NULL OR s.repo_id=?) ORDER BY r.name,s.service_path',
            )
            .all(workspaceId, repo?.id, repo?.id);
          writeStdout(renderJson(rows));
        }).catch(fail),
    );
  list
    .command('operations')
    .option('--workspace <path>')
    .option('--repo <name>')
    .option('--service <path>')
    .action(
      (opts: { workspace?: string; repo?: string; service?: string }) =>
        void withReadOnlyWorkspace(opts.workspace, (db, workspaceId) => {
          const selection = opts.repo
            ? selectRepository(db, opts.repo, workspaceId)
            : {};
          if (selection.diagnostic) {
            writeStdout(renderJson([selection.diagnostic]));
            return;
          }
          const repo = selection.repo;
          const rows = db
            .prepare(
              'SELECT r.name repo,s.service_path servicePath,o.operation_name operation,o.operation_path path FROM cds_operations o JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id WHERE r.workspace_id=? AND (? IS NULL OR s.repo_id=?) AND (? IS NULL OR s.service_path=?)',
            )
            .all(workspaceId, repo?.id, repo?.id, opts.service, opts.service);
          writeStdout(renderJson(rows));
        }).catch(fail),
    );
  list
    .command('calls')
    .option('--workspace <path>')
    .option('--repo <name>')
    .option('--operation <name>')
    .action(
      (opts: { workspace?: string; repo?: string; operation?: string }) =>
        void withReadOnlyWorkspace(opts.workspace, (db, workspaceId) => {
          const selection = opts.repo
            ? selectRepository(db, opts.repo, workspaceId)
            : {};
          if (selection.diagnostic) {
            writeStdout(renderJson([selection.diagnostic]));
            return;
          }
          const repo = selection.repo;
          const rows = db
            .prepare(
              'SELECT r.name repo,c.call_type type,c.operation_path_expr path,c.source_file file,c.source_line line FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id WHERE r.workspace_id=? AND (? IS NULL OR c.repo_id=?) AND (? IS NULL OR c.operation_path_expr=? OR c.operation_path_expr=? OR c.payload_summary LIKE ?)',
            )
            .all(
              workspaceId,
              repo?.id,
              repo?.id,
              opts.operation,
              opts.operation,
              opts.operation ? `/${opts.operation}` : undefined,
              opts.operation ? `%${opts.operation}%` : undefined,
            );
          writeStdout(renderJson(rows));
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
    .option('--implementation-repo <name>')
    .option('--implementation-hint <scope>', 'scoped implementation hint', collect, [])
    .option('--var <key=value>', 'dynamic variable', collect, [])
    .option('--dynamic-mode <mode>', 'strict|candidates|infer', 'strict')
    .option('--max-dynamic-candidates <n>', 'maximum dynamic candidates to show', '5')
    .action(
      (opts: {
        workspace?: string;
        repo?: string;
        operation?: string;
        service?: string;
        path?: string;
        format: string;
        implementationRepo?: string;
        implementationHint: string[];
        var: string[];
        dynamicMode: string;
        maxDynamicCandidates: string;
      }) =>
        void withReadOnlyWorkspace(opts.workspace, (db, workspaceId) => {
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
              workspaceId,
              includeAsync: true,
              includeDb: true,
              includeExternal: true,
              vars: parseVars(opts.var),
              implementationRepo: opts.implementationRepo,
              implementationHints: opts.implementationHint.map(parseImplementationHint),
              dynamicMode: parseDynamicMode(opts.dynamicMode),
              maxDynamicCandidates: parsePositiveInteger(opts.maxDynamicCandidates, 5),
            },
          );
          writeStdout(
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
        void withReadOnlyWorkspace(opts.workspace, (db, workspaceId) => {
          const selection = selectRepository(db, name, workspaceId);
          writeStdout(renderJson(
            selection.repo ?? selection.diagnostic ?? { error: 'repo not found' },
          ));
        }).catch(fail),
    );
  inspect
    .command('operation')
    .argument('<selector>')
    .option('--workspace <path>')
    .action(
      (selector: string, opts: { workspace?: string }) =>
        void withReadOnlyWorkspace(opts.workspace, (db, workspaceId) => {
          const rows = db
            .prepare(
              'SELECT o.* FROM cds_operations o JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id WHERE r.workspace_id=? AND (o.operation_name=? OR o.operation_path=?)',
            )
            .all(workspaceId, selector, selector);
          writeStdout(renderJson(rows));
        }).catch(fail),
    );
  program
    .command('doctor')
    .option('--workspace <path>')
    .option('--strict')
    .option('--detail')
    .option('--format <format>', 'json|table')
    .action(
      (opts: { workspace?: string; strict?: boolean; detail?: boolean; format?: string }) =>
        void withReadOnlyWorkspace(opts.workspace, (db) => {
          const allDiagnostics = doctorDiagnostics(db, Boolean(opts.strict), { detail: Boolean(opts.detail) });
          writeStdout(renderDoctorDiagnostics(allDiagnostics, opts.format));
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
          await cleanWorkspaceState(config, Boolean(opts.dbOnly));
          writeStdout('Cleaned service-flow state\n');
        })().catch(fail),
    );
  return program;
}
function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}
function parseDynamicMode(value: string | undefined): DynamicMode {
  if (value === undefined || value === 'strict') return 'strict';
  if (value === 'candidates' || value === 'infer') return value;
  throw new Error(`Invalid --dynamic-mode ${value}; expected strict, candidates, or infer`);
}
function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
function fail(error: unknown): void {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
createProgram().parse(process.argv);
