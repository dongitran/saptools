import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs/promises';
import pc from 'picocolors';
import { DEFAULT_IGNORES } from './config/defaults.js';
import {
  createWorkspaceConfig,
  loadWorkspaceConfig,
  saveWorkspaceConfig
} from './config/workspace-config.js';
import { openDatabase } from './db/connection.js';
import {
  getWorkspace,
  listRepositories,
  repoByName,
  upsertRepository,
  upsertWorkspace
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
async function init(
  workspace: string,
  options: { db?: string; ignore?: string[] }
): Promise<void> {
  const config = createWorkspaceConfig(
    workspace,
    options.db,
    options.ignore?.length ? options.ignore : [...DEFAULT_IGNORES]
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
      kind
    });
  }
  db.close();
  process.stdout.write(
    `Workspace: ${config.rootPath}\nDatabase: ${config.dbPath}\nRepositories: ${repos.length}\nIgnored: ${config.ignore.join(', ')}\nNext: service-flow index --workspace ${config.rootPath}\n`
  );
}
async function withWorkspace<T>(
  workspace: string | undefined,
  fn: (
    db: ReturnType<typeof openDatabase>,
    workspaceId: number,
    rootPath: string
  ) => Promise<T> | T
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
export function createProgram(): Command {
  const program = new Command();
  program
    .name('service-flow')
    .description(
      'Trace SAP CAP service-to-service flows across multi-repository workspaces'
    )
    .version('0.1.0');
  program
    .command('init')
    .argument('<workspace>')
    .option('--db <path>')
    .option('--ignore <pattern...>')
    .action(
      (workspace: string, opts: { db?: string; ignore?: string[] }) =>
        void init(workspace, opts).catch(fail)
    );
  program
    .command('index')
    .option('--workspace <path>')
    .option('--repo <name>')
    .option('--force')
    .option('--concurrency <n>', 'reserved for future parallel indexing', '1')
    .action(
      (opts: { workspace?: string; repo?: string; force?: boolean }) =>
        void withWorkspace(opts.workspace, async (db, workspaceId) => {
          const r = await indexWorkspace(db, workspaceId, {
            repo: opts.repo,
            force: Boolean(opts.force)
          });
          process.stdout.write(
            `Indexed ${r.repoCount} repositories, ${r.fileCount} files, ${r.diagnosticCount} diagnostics\n`
          );
        }).catch(fail)
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
            `Linked ${r.edgeCount} edges, ${r.unresolvedCount} unresolved\n`
          );
        }).catch(fail)
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
        void withWorkspace(opts.workspace, (db) => {
          const result = trace(
            db,
            {
              repo: opts.repo,
              servicePath: opts.service,
              operation: opts.operation,
              operationPath: opts.path,
              handler: opts.handler
            },
            {
              depth: Number(opts.depth),
              vars: parseVars(opts.var),
              includeExternal: Boolean(opts.includeExternal),
              includeDb: Boolean(opts.includeDb),
              includeAsync: Boolean(opts.includeAsync)
            }
          );
          process.stdout.write(
            opts.format === 'json'
              ? renderTraceJson(result)
              : opts.format === 'mermaid'
                ? renderMermaid(result)
                : renderTraceTable(result)
          );
        }).catch(fail)
    );
  const list = program.command('list');
  list
    .command('repos')
    .option('--workspace <path>')
    .action(
      (opts: { workspace?: string }) =>
        void withWorkspace(opts.workspace, (db) =>
          process.stdout.write(
            renderJson(
              listRepositories(db).map((r) => ({
                name: r.name,
                kind: r.kind,
                packageName: r.package_name
              }))
            )
          )
        ).catch(fail)
    );
  list
    .command('services')
    .option('--workspace <path>')
    .option('--repo <name>')
    .action(
      (opts: { workspace?: string; repo?: string }) =>
        void withWorkspace(opts.workspace, (db) => {
          const repo = opts.repo ? repoByName(db, opts.repo) : undefined;
          const rows = db
            .prepare(
              'SELECT r.name repo,s.service_path servicePath,s.qualified_name qualifiedName FROM cds_services s JOIN repositories r ON r.id=s.repo_id WHERE (? IS NULL OR s.repo_id=?) ORDER BY r.name,s.service_path'
            )
            .all(repo?.id, repo?.id);
          process.stdout.write(renderJson(rows));
        }).catch(fail)
    );
  list
    .command('operations')
    .option('--workspace <path>')
    .option('--repo <name>')
    .option('--service <path>')
    .action(
      (opts: { workspace?: string; repo?: string; service?: string }) =>
        void withWorkspace(opts.workspace, (db) => {
          const repo = opts.repo ? repoByName(db, opts.repo) : undefined;
          const rows = db
            .prepare(
              'SELECT r.name repo,s.service_path servicePath,o.operation_name operation,o.operation_path path FROM cds_operations o JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id WHERE (? IS NULL OR s.repo_id=?) AND (? IS NULL OR s.service_path=?)'
            )
            .all(repo?.id, repo?.id, opts.service, opts.service);
          process.stdout.write(renderJson(rows));
        }).catch(fail)
    );
  list
    .command('calls')
    .option('--workspace <path>')
    .option('--repo <name>')
    .option('--operation <name>')
    .action(
      (opts: { workspace?: string; repo?: string }) =>
        void withWorkspace(opts.workspace, (db) => {
          const repo = opts.repo ? repoByName(db, opts.repo) : undefined;
          const rows = db
            .prepare(
              'SELECT r.name repo,c.call_type type,c.operation_path_expr path,c.source_file file,c.source_line line FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id WHERE (? IS NULL OR c.repo_id=?)'
            )
            .all(repo?.id, repo?.id);
          process.stdout.write(renderJson(rows));
        }).catch(fail)
    );
  program
    .command('graph')
    .option('--workspace <path>')
    .option('--repo <name>')
    .option('--operation <name>')
    .option('--service <path>')
    .option('--path <operationPath>')
    .option('--format <format>', 'mermaid|json', 'mermaid')
    .action(
      (opts: {
        workspace?: string;
        repo?: string;
        operation?: string;
        service?: string;
        path?: string;
        format: string;
      }) =>
        void withWorkspace(opts.workspace, (db) => {
          const result = trace(
            db,
            {
              repo: opts.repo,
              operation: opts.operation,
              servicePath: opts.service,
              operationPath: opts.path
            },
            {
              depth: 100,
              includeAsync: true,
              includeDb: true,
              includeExternal: true
            }
          );
          process.stdout.write(
            opts.format === 'json'
              ? renderTraceJson(result)
              : renderMermaid(result)
          );
        }).catch(fail)
    );
  const inspect = program.command('inspect');
  inspect
    .command('repo')
    .argument('<name>')
    .option('--workspace <path>')
    .action(
      (name: string, opts: { workspace?: string }) =>
        void withWorkspace(opts.workspace, (db) =>
          process.stdout.write(
            renderJson(repoByName(db, name) ?? { error: 'repo not found' })
          )
        ).catch(fail)
    );
  inspect
    .command('operation')
    .argument('<selector>')
    .option('--workspace <path>')
    .action(
      (selector: string, opts: { workspace?: string }) =>
        void withWorkspace(opts.workspace, (db) => {
          const rows = db
            .prepare(
              'SELECT * FROM cds_operations WHERE operation_name=? OR operation_path=?'
            )
            .all(selector, selector);
          process.stdout.write(renderJson(rows));
        }).catch(fail)
    );
  program
    .command('doctor')
    .option('--workspace <path>')
    .action(
      (opts: { workspace?: string }) =>
        void withWorkspace(opts.workspace, (db) => {
          const diagnostics = db
            .prepare(
              'SELECT severity,code,message,source_file sourceFile,source_line sourceLine FROM diagnostics ORDER BY id'
            )
            .all();
          process.stdout.write(
            diagnostics.length
              ? renderJson(diagnostics)
              : `${pc.green('No diagnostics recorded')}\n`
          );
        }).catch(fail)
    );
  program
    .command('clean')
    .option('--workspace <path>')
    .option('--db-only')
    .action(
      (opts: { workspace?: string; dbOnly?: boolean }) =>
        void (async () => {
          const config = await loadWorkspaceConfig(opts.workspace);
          await fs.rm(config.dbPath, { force: true });
          if (!opts.dbOnly)
            await fs.rm(path.dirname(config.dbPath), {
              recursive: true,
              force: true
            });
          process.stdout.write('Cleaned service-flow state\n');
        })().catch(fail)
    );
  return program;
}
function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}
function fail(error: unknown): void {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
createProgram().parse(process.argv);
