import { attachSelfUpdate, registerSelfUpdateCommand } from '@saptools/core';
import { Command, Option } from 'commander';
import { DEFAULT_IGNORES } from './config/defaults.js';
import {
  createWorkspaceConfig,
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  type WorkspaceConfig,
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
import { factLifecycleDiagnostic } from './db/fact-lifecycle.js';
import { trace } from './trace/trace-engine.js';
import { traceAndCompact } from './trace/compact-trace.js';
import {
  parseVars,
  selectorRepoAmbiguousDiagnostic,
} from './trace/selectors.js';
import { parseImplementationHint } from './trace/implementation-hints.js';
import { renderTraceTable } from './output/table-output.js';
import { renderTraceJson, renderJson } from './output/json-output.js';
import { renderDoctorDiagnostics } from './output/doctor-output.js';
import { renderMermaid } from './output/mermaid-output.js';
import { createStdoutWriter } from './output/stdout-policy.js';
import { renderCompactJson } from './output/compact-json-output.js';
import {
  projectRepositoryInspection,
} from './output/repository-inspection.js';
import { VERSION } from './version.js';
import type {
  DynamicMode,
  TraceOptions,
  TraceResult,
  TraceStart,
} from './types.js';
import { cleanWorkspaceState } from './cli/clean.js';
import { indexCommandOutcome } from './cli/index-summary.js';
import { normalizeEventEnvironmentKeys } from
  './parsers/environment-declarations.js';
import { traceStartRefused } from './cli/trace-exit-status.js';

const stdout = createStdoutWriter(process.stdout, fail);
const TRACE_FORMATS = ['table', 'json', 'mermaid', 'compact-json'] as const;
const GRAPH_FORMATS = ['mermaid', 'json', 'compact-json'] as const;

type TraceFormat = (typeof TRACE_FORMATS)[number];
type GraphFormat = (typeof GRAPH_FORMATS)[number];

interface TraceCommandOptions {
  workspace?: string;
  repo?: string;
  operation?: string;
  service?: string;
  path?: string;
  handler?: string;
  depth: string;
  format: TraceFormat;
  includeExternal?: boolean;
  includeDb?: boolean;
  includeAsync?: boolean;
  implementationRepo?: string;
  implementationHint: string[];
  var: string[];
  dynamicMode: string;
  maxDynamicCandidates: string;
}

interface GraphCommandOptions {
  workspace?: string;
  repo?: string;
  operation?: string;
  service?: string;
  path?: string;
  format: GraphFormat;
  implementationRepo?: string;
  implementationHint: string[];
  var: string[];
  dynamicMode: string;
  maxDynamicCandidates: string;
}

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
    config: WorkspaceConfig,
  ) => Promise<T> | T,
): Promise<T> {
  const config = await loadWorkspaceConfig(workspace);
  const db = openDatabase(config.dbPath);
  try {
    const row = getWorkspace(db, config.rootPath);
    const workspaceId =
      row?.id ?? upsertWorkspace(db, config.rootPath, config.dbPath);
    return await fn(db, workspaceId, config.rootPath, config);
  } finally {
    db.close();
  }
}
async function withReadOnlyWorkspace<T>(
  workspace: string | undefined,
  fn: (db: ReturnType<typeof openDatabase>, workspaceId: number, rootPath: string) => Promise<T> | T,
): Promise<T> {
  const config = await loadWorkspaceConfig(workspace);
  const dbPath = process.env.SERVICE_FLOW_DB ?? config.dbPath;
  const db = openReadOnlyDatabase(dbPath);
  try {
    const row = getWorkspace(db, config.rootPath);
    if (!row) throw new Error(`Workspace is not initialized in ${dbPath}`);
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

function traceFormatOption(): Option {
  return new Option('--format <format>', TRACE_FORMATS.join('|'))
    .choices([...TRACE_FORMATS])
    .default('table');
}

function graphFormatOption(): Option {
  return new Option('--format <format>', GRAPH_FORMATS.join('|'))
    .choices([...GRAPH_FORMATS])
    .default('mermaid');
}

function writeTraceOutput(
  db: Db,
  start: TraceStart,
  options: TraceOptions,
  format: TraceFormat | GraphFormat,
): void {
  if (format === 'compact-json') {
    const execution = traceAndCompact(db, start, options);
    writeStdout(renderCompactJson(execution.compact));
    markRefusedTraceStart(execution.trace.diagnostics);
    return;
  }
  const result = trace(db, start, options);
  writeStdout(renderDetailedTrace(result, format));
  markRefusedTraceStart(result.diagnostics);
}

function markRefusedTraceStart(
  diagnostics: ReadonlyArray<Record<string, unknown>>,
): void {
  if (traceStartRefused(diagnostics)) process.exitCode = 1;
}

function renderDetailedTrace(
  result: TraceResult,
  format: Exclude<TraceFormat, 'compact-json'> | Exclude<GraphFormat, 'compact-json'>,
): string {
  if (format === 'json') return renderTraceJson(result);
  if (format === 'mermaid') return renderMermaid(result);
  return renderTraceTable(result);
}

async function runTraceCommand(opts: TraceCommandOptions): Promise<void> {
  if (!opts.repo && !opts.operation && !opts.service
    && !opts.path && !opts.handler)
    throw new Error(
      'trace_selector_required: provide --repo, --service, --operation, --path, or --handler',
    );
  await withReadOnlyWorkspace(opts.workspace, (db, workspaceId) => {
    const start: TraceStart = {
      repo: opts.repo, servicePath: opts.service, operation: opts.operation,
      operationPath: opts.path, handler: opts.handler,
    };
    const options: TraceOptions = {
      depth: Number(opts.depth), workspaceId, vars: parseVars(opts.var),
      includeExternal: Boolean(opts.includeExternal),
      includeDb: Boolean(opts.includeDb), includeAsync: Boolean(opts.includeAsync),
      implementationRepo: opts.implementationRepo,
      implementationHints: opts.implementationHint.map(parseImplementationHint),
      dynamicMode: parseDynamicMode(opts.dynamicMode),
      maxDynamicCandidates: parsePositiveInteger(opts.maxDynamicCandidates, 5),
    };
    writeTraceOutput(db, start, options, opts.format);
  });
}

function runGraphCommand(opts: GraphCommandOptions): Promise<void> {
  return withReadOnlyWorkspace(opts.workspace, (db, workspaceId) => {
    const start: TraceStart = {
      repo: opts.repo, operation: opts.operation, servicePath: opts.service,
      operationPath: opts.path,
    };
    const options: TraceOptions = {
      depth: 100, workspaceId, includeAsync: true, includeDb: true,
      includeExternal: true, vars: parseVars(opts.var),
      implementationRepo: opts.implementationRepo,
      implementationHints: opts.implementationHint.map(parseImplementationHint),
      dynamicMode: parseDynamicMode(opts.dynamicMode),
      maxDynamicCandidates: parsePositiveInteger(opts.maxDynamicCandidates, 5),
    };
    writeTraceOutput(db, start, options, opts.format);
  });
}

function configuredProgram(): Command {
  return new Command()
    .name('service-flow')
    .description(
      'Trace SAP CAP service-to-service flows across multi-repository workspaces',
    )
    .version(VERSION);
}

function registerInitCommand(program: Command): void {
  program
    .command('init')
    .argument('<workspace>')
    .option('--db <path>')
    .option('--ignore <pattern...>')
    .action(
      (workspace: string, opts: { db?: string; ignore?: string[] }) =>
        void init(workspace, opts).catch(fail),
    );
}

function registerIndexCommand(program: Command): void {
  program
    .command('index')
    .option('--workspace <path>')
    .option('--repo <name>')
    .option('--force')
    .option(
      '--event-environment-key <key>',
      'allowlisted event environment key (repeatable)',
      collect,
      [],
    )
    .action(
      (opts: {
        workspace?: string;
        repo?: string;
        force?: boolean;
        eventEnvironmentKey: string[];
      }) =>
        void withWorkspace(opts.workspace, async (db, workspaceId, _root, config) => {
          const configuredKeys = opts.eventEnvironmentKey.length > 0
            ? normalizeEventEnvironmentKeys(opts.eventEnvironmentKey)
            : config.eventEnvironmentKeys;
          if (opts.eventEnvironmentKey.length > 0)
            await saveWorkspaceConfig({
              ...config,
              eventEnvironmentKeys: configuredKeys,
              updatedAt: new Date().toISOString(),
            });
          const r = await indexWorkspace(db, workspaceId, {
            repo: opts.repo,
            force: Boolean(opts.force),
            eventEnvironmentKeys: configuredKeys,
          });
          const outcome = indexCommandOutcome(r);
          writeStdout(outcome.stdout);
          if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode;
        }).catch(fail),
    );
}

function registerLinkCommand(program: Command): void {
  program
    .command('link')
    .option('--workspace <path>')
    .option('--force')
    .action(
      (opts: { workspace?: string }) =>
        void withWorkspace(opts.workspace, (db, workspaceId) => {
          const r = linkWorkspace(db, workspaceId);
          // Run after the graph transaction commits. Full ANALYZE also covers
          // the joined handler tables that PRAGMA optimize may skip, and is
          // required for the graph/symbol lookup indexes to receive their
          // measured query plans.
          db.exec('ANALYZE');
          const upgradeWarnings = linkUpgradeWarnings(db, workspaceId);
          writeStdout(
            `${upgradeWarnings.length ? `Warnings: ${upgradeWarnings.map((item) => String(item.code)).join(', ')}. Run service-flow doctor --strict for remediation.\n` : ''}Linked ${r.edgeCount} edges: ${r.remoteResolvedCount} remote operation calls resolved, ${r.localResolvedCount} local operation calls resolved, ${r.unresolvedCount} unresolved operation calls, ${r.ambiguousCount} ambiguous operation calls, ${r.dynamicCount} dynamic operation calls, ${r.terminalCount} terminal call edges, ${r.dependencyResolvedCount} dependency resolved, ${r.dependencyAmbiguousCount} dependency ambiguous, ${r.implementationResolvedCount} implementation resolved, ${r.implementationAmbiguousCount} implementation ambiguous, ${r.implementationUnresolvedCount} implementation unresolved, ${r.subscriptionHandlerResolvedCount} subscription handlers resolved, ${r.subscriptionHandlerAmbiguousCount} subscription handlers ambiguous, ${r.subscriptionHandlerUnresolvedCount} subscription handlers unresolved, ${r.subscriptionHandlerMissingAssociationCount} subscription handler associations missing, ${r.eventShapeCandidateCount} event shape candidates, ${r.eventShapeCandidateOmittedCount} event shape candidates refused by the diagnosed safety cap\n`,
          );
        }).catch(fail),
    );
}

function registerTraceCommand(program: Command): void {
  program
    .command('trace')
    .option('--workspace <path>')
    .option('--repo <name>')
    .option('--operation <name>')
    .option('--service <path>')
    .option('--path <operationPath>')
    .option('--handler <name>')
    .option('--depth <n>', 'trace depth', '25')
    .addOption(traceFormatOption())
    .option('--include-external')
    .option('--include-db')
    .option('--include-async')
    .option('--implementation-repo <name>')
    .option('--implementation-hint <scope>', 'scoped implementation hint', collect, [])
    .option('--var <key=value>', 'dynamic variable', collect, [])
    .option('--dynamic-mode <mode>', 'strict|candidates|infer', 'strict')
    .option('--max-dynamic-candidates <n>', 'maximum dynamic candidates to show', '5')
    .action((opts: TraceCommandOptions) => void runTraceCommand(opts).catch(fail));
}

function listRepositoriesCommand(
  opts: { workspace?: string },
): Promise<void> {
  return withReadOnlyWorkspace(opts.workspace, (db, workspaceId) => {
    if (writeLifecycleBlock(db, workspaceId)) return;
    writeStdout(renderJson(
      listRepositories(db, workspaceId).map((repo) => ({
        name: repo.name,
        kind: repo.kind,
        packageName: repo.package_name,
      })),
    ));
  });
}

function listServicesCommand(
  opts: { workspace?: string; repo?: string },
): Promise<void> {
  return withReadOnlyWorkspace(opts.workspace, (db, workspaceId) => {
    if (writeLifecycleBlock(db, workspaceId)) return;
    const selection = opts.repo
      ? selectRepository(db, opts.repo, workspaceId) : {};
    if (selection.diagnostic) {
      writeStdout(renderJson([selection.diagnostic]));
      return;
    }
    const repo = selection.repo;
    const rows = db.prepare(
      'SELECT r.name repo,s.service_path servicePath,s.qualified_name qualifiedName FROM cds_services s JOIN repositories r ON r.id=s.repo_id WHERE r.workspace_id=? AND (? IS NULL OR s.repo_id=?) ORDER BY r.name,s.service_path',
    ).all(workspaceId, repo?.id, repo?.id);
    writeStdout(renderJson(rows));
  });
}

function listOperationsCommand(
  opts: { workspace?: string; repo?: string; service?: string },
): Promise<void> {
  return withReadOnlyWorkspace(opts.workspace, (db, workspaceId) => {
    if (writeLifecycleBlock(db, workspaceId)) return;
    const selection = opts.repo
      ? selectRepository(db, opts.repo, workspaceId) : {};
    if (selection.diagnostic) {
      writeStdout(renderJson([selection.diagnostic]));
      return;
    }
    const repo = selection.repo;
    const rows = db.prepare(
      'SELECT r.name repo,s.service_path servicePath,o.operation_name operation,o.operation_path path FROM cds_operations o JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id WHERE r.workspace_id=? AND (? IS NULL OR s.repo_id=?) AND (? IS NULL OR s.service_path=?)',
    ).all(
      workspaceId, repo?.id, repo?.id, opts.service, opts.service,
    );
    writeStdout(renderJson(rows));
  });
}

function listCallsCommand(
  opts: { workspace?: string; repo?: string; operation?: string },
): Promise<void> {
  return withReadOnlyWorkspace(opts.workspace, (db, workspaceId) => {
    if (writeLifecycleBlock(db, workspaceId)) return;
    const selection = opts.repo
      ? selectRepository(db, opts.repo, workspaceId) : {};
    if (selection.diagnostic) {
      writeStdout(renderJson([selection.diagnostic]));
      return;
    }
    const repo = selection.repo;
    const rows = db.prepare(
      'SELECT r.name repo,c.call_type type,c.operation_path_expr path,c.source_file file,c.source_line line FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id WHERE r.workspace_id=? AND (? IS NULL OR c.repo_id=?) AND (? IS NULL OR c.operation_path_expr=? OR c.operation_path_expr=? OR c.payload_summary LIKE ?)',
    ).all(
      workspaceId, repo?.id, repo?.id, opts.operation, opts.operation,
      opts.operation ? `/${opts.operation}` : undefined,
      opts.operation ? `%${opts.operation}%` : undefined,
    );
    writeStdout(renderJson(rows));
  });
}

function registerListCommands(program: Command): void {
  const list = program.command('list');
  list
    .command('repos')
    .option('--workspace <path>')
    .action(
      (opts: { workspace?: string }) =>
        void listRepositoriesCommand(opts).catch(fail),
    );
  list
    .command('services')
    .option('--workspace <path>')
    .option('--repo <name>')
    .action(
      (opts: { workspace?: string; repo?: string }) =>
        void listServicesCommand(opts).catch(fail),
    );
  list
    .command('operations')
    .option('--workspace <path>')
    .option('--repo <name>')
    .option('--service <path>')
    .action(
      (opts: { workspace?: string; repo?: string; service?: string }) =>
        void listOperationsCommand(opts).catch(fail),
    );
  list
    .command('calls')
    .option('--workspace <path>')
    .option('--repo <name>')
    .option('--operation <name>')
    .action(
      (opts: { workspace?: string; repo?: string; operation?: string }) =>
        void listCallsCommand(opts).catch(fail),
    );
}

function registerGraphCommand(program: Command): void {
  program
    .command('graph')
    .option('--workspace <path>')
    .option('--repo <name>')
    .option('--operation <name>')
    .option('--service <path>')
    .option('--path <operationPath>')
    .addOption(graphFormatOption())
    .option('--implementation-repo <name>')
    .option('--implementation-hint <scope>', 'scoped implementation hint', collect, [])
    .option('--var <key=value>', 'dynamic variable', collect, [])
    .option('--dynamic-mode <mode>', 'strict|candidates|infer', 'strict')
    .option('--max-dynamic-candidates <n>', 'maximum dynamic candidates to show', '5')
    .action((opts: GraphCommandOptions) => void runGraphCommand(opts).catch(fail));
}

function inspectRepositoryCommand(
  name: string,
  opts: { workspace?: string },
): Promise<void> {
  return withReadOnlyWorkspace(opts.workspace, (db, workspaceId) => {
    if (writeLifecycleBlock(db, workspaceId)) return;
    const selection = selectRepository(db, name, workspaceId);
    writeStdout(renderJson(
      selection.repo
        ? projectRepositoryInspection(selection.repo)
        : selection.diagnostic ?? { error: 'repo not found' },
    ));
  });
}

function inspectOperationCommand(
  selector: string,
  opts: { workspace?: string },
): Promise<void> {
  return withReadOnlyWorkspace(opts.workspace, (db, workspaceId) => {
    if (writeLifecycleBlock(db, workspaceId)) return;
    const rows = db.prepare(`SELECT o.*,
      r.name repository_name,r.package_name repository_package_name,
      s.service_name,s.qualified_name qualified_service_name,s.service_path
      FROM cds_operations o
      JOIN cds_services s ON s.id=o.service_id
      JOIN repositories r ON r.id=s.repo_id
      WHERE r.workspace_id=?
        AND (o.operation_name=? OR o.operation_path=?)
      ORDER BY r.name COLLATE BINARY,s.service_path COLLATE BINARY,o.id`)
      .all(workspaceId, selector, selector);
    if (rows.length > 0) {
      writeStdout(renderJson(rows));
      return;
    }
    writeStdout(renderJson([{
      severity: 'warning',
      code: 'selector_operation_not_found',
      message: `Operation selector not found: ${selector}`,
      selectorKind: 'operation',
      selector,
    }]));
    process.exitCode = 1;
  });
}

async function runDoctorCommand(opts: {
  workspace?: string;
  strict?: boolean;
  detail?: boolean;
  format?: string;
}): Promise<void> {
  if (opts.detail && !opts.strict)
    throw new Error('doctor_detail_requires_strict');
  await withReadOnlyWorkspace(opts.workspace, (db, workspaceId) => {
    const allDiagnostics = doctorDiagnostics(db, Boolean(opts.strict), {
      detail: Boolean(opts.detail), workspaceId,
    });
    writeStdout(renderDoctorDiagnostics(allDiagnostics, opts.format));
  });
}

function writeLifecycleBlock(db: Db, workspaceId: number): boolean {
  const diagnostic = factLifecycleDiagnostic(db, workspaceId);
  if (!diagnostic) return false;
  writeStdout(renderJson([diagnostic]));
  process.exitCode = 1;
  return true;
}

function registerInspectCommands(program: Command): void {
  const inspect = program.command('inspect');
  inspect
    .command('repo')
    .argument('<name>')
    .option('--workspace <path>')
    .action(
      (name: string, opts: { workspace?: string }) =>
        void inspectRepositoryCommand(name, opts).catch(fail),
    );
  inspect
    .command('operation')
    .argument('<selector>')
    .option('--workspace <path>')
    .action(
      (selector: string, opts: { workspace?: string }) =>
        void inspectOperationCommand(selector, opts).catch(fail),
    );
}

function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .option('--workspace <path>')
    .option('--strict')
    .option('--detail')
    .option('--format <format>', 'json|table')
    .action(
      (opts: { workspace?: string; strict?: boolean; detail?: boolean; format?: string }) =>
        void runDoctorCommand(opts).catch(fail),
    );
}

function registerCleanCommand(program: Command): void {
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
}

// Every command first checks npm (at most once an hour) and re-runs itself on a newer release; see `@saptools/core`.
const SELF_UPDATE = { packageName: '@saptools/service-flow', currentVersion: VERSION, binName: 'service-flow', envPrefix: 'SERVICE_FLOW' };

export function createProgram(): Command {
  const program = configuredProgram();
  attachSelfUpdate(program, SELF_UPDATE);
  registerInitCommand(program);
  registerIndexCommand(program);
  registerLinkCommand(program);
  registerTraceCommand(program);
  registerListCommands(program);
  registerGraphCommand(program);
  registerInspectCommands(program);
  registerDoctorCommand(program);
  registerCleanCommand(program);
  registerSelfUpdateCommand(program, SELF_UPDATE);
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
await createProgram().parseAsync(process.argv);
