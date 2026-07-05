#!/usr/bin/env node
import {
  containsSupportedOutboundCall,
  discoverRepositories,
  linkWorkspace,
  normalizeODataOperationInvocationPath,
  normalizePath,
  parseCdsFile,
  parseDecorators,
  parseHandlerRegistrations,
  parseOutboundCalls,
  parsePackageJson,
  parseServiceBindings,
  trace
} from "./chunk-CWJYVIG2.js";

// src/cli.ts
import { Command } from "commander";
import path6 from "path";
import fs6 from "fs/promises";
import pc from "picocolors";

// src/config/defaults.ts
var DEFAULT_IGNORES = [
  "node_modules",
  "gen",
  "dist",
  "coverage",
  ".git",
  ".turbo",
  ".next",
  ".cache",
  ".service-flow"
];
var CONFIG_DIR = ".service-flow";
var CONFIG_FILE = "config.json";
var DEFAULT_DB_FILE = "service-flow.db";

// src/config/workspace-config.ts
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
var schema = z.object({
  rootPath: z.string(),
  dbPath: z.string(),
  ignore: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string()
});
function configPath(rootPath) {
  return path.join(rootPath, CONFIG_DIR, CONFIG_FILE);
}
function defaultDbPath(rootPath) {
  return path.join(rootPath, CONFIG_DIR, DEFAULT_DB_FILE);
}
async function saveWorkspaceConfig(config) {
  await fs.mkdir(path.dirname(configPath(config.rootPath)), {
    recursive: true
  });
  await fs.writeFile(
    configPath(config.rootPath),
    `${JSON.stringify(config, null, 2)}
`
  );
  if (path.dirname(config.dbPath) === path.dirname(configPath(config.rootPath)))
    await fs.writeFile(
      path.join(path.dirname(config.dbPath), ".service-flow-state"),
      "service-flow\n"
    );
}
async function loadWorkspaceConfig(workspace) {
  const root = path.resolve(workspace ?? process.cwd());
  const data = await fs.readFile(configPath(root), "utf8");
  return schema.parse(JSON.parse(data));
}
function createWorkspaceConfig(rootPath, dbPath, ignore = [...DEFAULT_IGNORES]) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const root = path.resolve(rootPath);
  return {
    rootPath: root,
    dbPath: path.resolve(dbPath ?? defaultDbPath(root)),
    ignore,
    createdAt: now,
    updatedAt: now
  };
}

// src/db/connection.ts
import fs2 from "fs";
import path2 from "path";

// src/db/schema.ts
var schemaSql = `
CREATE TABLE IF NOT EXISTS workspaces (id INTEGER PRIMARY KEY, root_path TEXT UNIQUE NOT NULL, db_path TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS repositories (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, name TEXT NOT NULL, absolute_path TEXT NOT NULL, relative_path TEXT NOT NULL, package_name TEXT, package_version TEXT, dependencies_json TEXT DEFAULT '{}', kind TEXT NOT NULL, is_git_repo INTEGER NOT NULL, last_indexed_at TEXT, index_status TEXT DEFAULT 'pending', error_count INTEGER DEFAULT 0, fingerprint TEXT, fact_generation INTEGER NOT NULL DEFAULT 0, graph_generation INTEGER NOT NULL DEFAULT 0, graph_stale_reason TEXT, graph_stale_at TEXT, UNIQUE(workspace_id, absolute_path), FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, relative_path TEXT NOT NULL, extension TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, last_indexed_at TEXT NOT NULL, UNIQUE(repo_id, relative_path), FOREIGN KEY(repo_id) REFERENCES repositories(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS cds_requires (id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, alias TEXT NOT NULL, kind TEXT, model TEXT, destination TEXT, service_path TEXT, request_timeout INTEGER, raw_json TEXT NOT NULL, FOREIGN KEY(repo_id) REFERENCES repositories(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS cds_services (id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, namespace TEXT, service_name TEXT NOT NULL, qualified_name TEXT NOT NULL, service_path TEXT NOT NULL, is_extend INTEGER NOT NULL, source_file TEXT NOT NULL, source_line INTEGER NOT NULL, FOREIGN KEY(repo_id) REFERENCES repositories(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS cds_operations (id INTEGER PRIMARY KEY, service_id INTEGER NOT NULL, operation_type TEXT NOT NULL, operation_name TEXT NOT NULL, operation_path TEXT NOT NULL, params_json TEXT NOT NULL, return_type TEXT, source_file TEXT NOT NULL, source_line INTEGER NOT NULL, FOREIGN KEY(service_id) REFERENCES cds_services(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS symbols (id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, file_id INTEGER, kind TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT NOT NULL, exported INTEGER NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, start_offset INTEGER, end_offset INTEGER, source_file TEXT, exported_name TEXT, evidence_json TEXT, FOREIGN KEY(repo_id) REFERENCES repositories(id) ON DELETE CASCADE, FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS handler_classes (id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, symbol_id INTEGER, class_name TEXT NOT NULL, source_file TEXT NOT NULL, source_line INTEGER NOT NULL, FOREIGN KEY(repo_id) REFERENCES repositories(id) ON DELETE CASCADE, FOREIGN KEY(symbol_id) REFERENCES symbols(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS handler_methods (id INTEGER PRIMARY KEY, handler_class_id INTEGER NOT NULL, method_name TEXT NOT NULL, decorator_kind TEXT NOT NULL, decorator_value TEXT, decorator_raw_expression TEXT NOT NULL, source_file TEXT NOT NULL, source_line INTEGER NOT NULL, FOREIGN KEY(handler_class_id) REFERENCES handler_classes(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS handler_registrations (id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, handler_class_id INTEGER, class_name TEXT, import_source TEXT, registration_file TEXT NOT NULL, registration_line INTEGER NOT NULL, registration_kind TEXT NOT NULL, confidence REAL NOT NULL, FOREIGN KEY(repo_id) REFERENCES repositories(id) ON DELETE CASCADE, FOREIGN KEY(handler_class_id) REFERENCES handler_classes(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS service_bindings (id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, symbol_id INTEGER, variable_name TEXT NOT NULL, alias TEXT, alias_expr TEXT, destination_expr TEXT, service_path_expr TEXT, is_dynamic INTEGER NOT NULL, placeholders_json TEXT NOT NULL, source_file TEXT NOT NULL, source_line INTEGER NOT NULL, helper_chain_json TEXT, FOREIGN KEY(repo_id) REFERENCES repositories(id) ON DELETE CASCADE, FOREIGN KEY(symbol_id) REFERENCES symbols(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS outbound_calls (id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, source_symbol_id INTEGER, call_type TEXT NOT NULL, service_binding_id INTEGER, method TEXT, operation_path_expr TEXT, query_entity TEXT, event_name_expr TEXT, payload_summary TEXT, source_file TEXT NOT NULL, source_line INTEGER NOT NULL, confidence REAL NOT NULL, unresolved_reason TEXT, local_service_name TEXT, local_service_lookup TEXT, alias_chain_json TEXT, evidence_json TEXT, external_target_kind TEXT, external_target_id TEXT, external_target_label TEXT, external_target_dynamic INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(repo_id) REFERENCES repositories(id) ON DELETE CASCADE, FOREIGN KEY(source_symbol_id) REFERENCES symbols(id) ON DELETE SET NULL, FOREIGN KEY(service_binding_id) REFERENCES service_bindings(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS symbol_calls (id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, caller_symbol_id INTEGER NOT NULL, callee_symbol_id INTEGER, callee_expression TEXT NOT NULL, import_source TEXT, source_file TEXT NOT NULL, source_line INTEGER NOT NULL, status TEXT NOT NULL, confidence REAL NOT NULL, evidence_json TEXT NOT NULL, unresolved_reason TEXT, FOREIGN KEY(repo_id) REFERENCES repositories(id) ON DELETE CASCADE, FOREIGN KEY(caller_symbol_id) REFERENCES symbols(id) ON DELETE CASCADE, FOREIGN KEY(callee_symbol_id) REFERENCES symbols(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS graph_edges (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, edge_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unresolved', from_kind TEXT NOT NULL, from_id TEXT NOT NULL, to_kind TEXT NOT NULL, to_id TEXT NOT NULL, confidence REAL NOT NULL, evidence_json TEXT NOT NULL, is_dynamic INTEGER NOT NULL, unresolved_reason TEXT, generation INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS index_runs (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, repo_count INTEGER NOT NULL, file_count INTEGER NOT NULL, diagnostic_count INTEGER NOT NULL, error_message TEXT, FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS diagnostics (id INTEGER PRIMARY KEY, repo_id INTEGER, file_id INTEGER, severity TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL, source_file TEXT, source_line INTEGER, FOREIGN KEY(repo_id) REFERENCES repositories(id) ON DELETE CASCADE, FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE SET NULL);
CREATE INDEX IF NOT EXISTS idx_repo_name ON repositories(name);
CREATE INDEX IF NOT EXISTS idx_service_path ON cds_services(service_path);
CREATE INDEX IF NOT EXISTS idx_operation_name ON cds_operations(operation_name, operation_path);
CREATE INDEX IF NOT EXISTS idx_calls_repo ON outbound_calls(repo_id, call_type);
CREATE INDEX IF NOT EXISTS idx_symbol_calls_caller ON symbol_calls(repo_id, caller_symbol_id);
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(kind, name, path, repo);
`;

// src/db/migrations.ts
var CURRENT_SCHEMA_VERSION = 7;
var columns = {
  service_bindings: [
    { name: "helper_chain_json", ddl: "ALTER TABLE service_bindings ADD COLUMN helper_chain_json TEXT" },
    { name: "alias_expr", ddl: "ALTER TABLE service_bindings ADD COLUMN alias_expr TEXT" }
  ],
  repositories: [
    { name: "fingerprint", ddl: "ALTER TABLE repositories ADD COLUMN fingerprint TEXT" },
    { name: "fact_generation", ddl: "ALTER TABLE repositories ADD COLUMN fact_generation INTEGER NOT NULL DEFAULT 0" },
    { name: "graph_generation", ddl: "ALTER TABLE repositories ADD COLUMN graph_generation INTEGER NOT NULL DEFAULT 0" },
    { name: "graph_stale_reason", ddl: "ALTER TABLE repositories ADD COLUMN graph_stale_reason TEXT" },
    { name: "graph_stale_at", ddl: "ALTER TABLE repositories ADD COLUMN graph_stale_at TEXT" }
  ],
  graph_edges: [
    { name: "status", ddl: "ALTER TABLE graph_edges ADD COLUMN status TEXT NOT NULL DEFAULT 'unresolved'" },
    { name: "generation", ddl: "ALTER TABLE graph_edges ADD COLUMN generation INTEGER NOT NULL DEFAULT 0" }
  ],
  handler_registrations: [
    { name: "class_name", ddl: "ALTER TABLE handler_registrations ADD COLUMN class_name TEXT" },
    { name: "import_source", ddl: "ALTER TABLE handler_registrations ADD COLUMN import_source TEXT" }
  ],
  symbols: [
    { name: "start_offset", ddl: "ALTER TABLE symbols ADD COLUMN start_offset INTEGER" },
    { name: "end_offset", ddl: "ALTER TABLE symbols ADD COLUMN end_offset INTEGER" },
    { name: "source_file", ddl: "ALTER TABLE symbols ADD COLUMN source_file TEXT" },
    { name: "exported_name", ddl: "ALTER TABLE symbols ADD COLUMN exported_name TEXT" },
    { name: "evidence_json", ddl: "ALTER TABLE symbols ADD COLUMN evidence_json TEXT" }
  ],
  outbound_calls: [
    { name: "local_service_name", ddl: "ALTER TABLE outbound_calls ADD COLUMN local_service_name TEXT" },
    { name: "local_service_lookup", ddl: "ALTER TABLE outbound_calls ADD COLUMN local_service_lookup TEXT" },
    { name: "alias_chain_json", ddl: "ALTER TABLE outbound_calls ADD COLUMN alias_chain_json TEXT" },
    { name: "evidence_json", ddl: "ALTER TABLE outbound_calls ADD COLUMN evidence_json TEXT" },
    { name: "external_target_kind", ddl: "ALTER TABLE outbound_calls ADD COLUMN external_target_kind TEXT" },
    { name: "external_target_id", ddl: "ALTER TABLE outbound_calls ADD COLUMN external_target_id TEXT" },
    { name: "external_target_label", ddl: "ALTER TABLE outbound_calls ADD COLUMN external_target_label TEXT" },
    { name: "external_target_dynamic", ddl: "ALTER TABLE outbound_calls ADD COLUMN external_target_dynamic INTEGER NOT NULL DEFAULT 0" }
  ],
  index_runs: [
    { name: "error_message", ddl: "ALTER TABLE index_runs ADD COLUMN error_message TEXT" }
  ]
};
function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}
function userVersion(db) {
  const row = db.pragma("user_version")[0];
  return Number(row?.user_version ?? 0);
}
function addMissingColumns(db) {
  for (const [table, tableColumns] of Object.entries(columns)) {
    for (const column of tableColumns) {
      if (!hasColumn(db, table, column.name)) db.prepare(column.ddl).run();
    }
  }
}
function normalizeLegacyStatus(db) {
  db.prepare("UPDATE graph_edges SET status=CASE WHEN edge_type='REMOTE_CALL_RESOLVES_TO_OPERATION' THEN 'resolved' WHEN edge_type IN ('HANDLER_RUNS_DB_QUERY','HANDLER_CALLS_EXTERNAL_HTTP','HANDLER_EMITS_EVENT','EVENT_CONSUMED_BY_HANDLER') THEN 'terminal' WHEN edge_type='DYNAMIC_EDGE_CANDIDATE' THEN 'dynamic' WHEN status='ambiguous' THEN 'ambiguous' ELSE status END").run();
  db.prepare("UPDATE repositories SET graph_stale_reason='schema_migration_requires_relink', graph_stale_at=COALESCE(graph_stale_at, datetime('now')) WHERE EXISTS (SELECT 1 FROM graph_edges WHERE graph_edges.workspace_id=repositories.workspace_id) AND graph_generation=0").run();
}
function migrate(db) {
  db.transaction(() => {
    const version = userVersion(db);
    if (version > CURRENT_SCHEMA_VERSION) throw new Error(`Unsupported future service-flow schema version ${version}`);
    db.exec(schemaSql);
    addMissingColumns(db);
    normalizeLegacyStatus(db);
    const violations = db.pragma("foreign_key_check");
    if (violations.length > 0) throw new Error("SQLite foreign_key_check failed during migration");
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  });
}

// package.json
var package_default = {
  name: "@saptools/service-flow",
  version: "0.1.33",
  description: "Trace SAP CAP service-to-service flows across multi-repository workspaces with runtime-aware graph resolution",
  type: "module",
  publishConfig: {
    access: "public",
    registry: "https://registry.npmjs.org/"
  },
  bin: {
    "service-flow": "dist/cli.js"
  },
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js"
    }
  },
  files: [
    "CHANGELOG.md",
    "README.md",
    "TECHNICAL-NOTE.md",
    "dist"
  ],
  engines: {
    node: ">=24.0.0"
  },
  scripts: {
    build: "tsup",
    typecheck: "tsc --noEmit",
    lint: "eslint src tests",
    test: "vitest run tests/unit",
    "test:unit": "vitest run tests/unit",
    "test:e2e": "vitest run tests/e2e",
    "test:e2e:fake": "vitest run tests/e2e"
  },
  keywords: [
    "sap",
    "cap",
    "cds",
    "btp",
    "cli",
    "service-graph",
    "call-graph",
    "sqlite",
    "saptools"
  ],
  author: "Dong Tran",
  license: "MIT",
  repository: {
    type: "git",
    url: "git+https://github.com/dongitran/saptools.git",
    directory: "packages/service-flow"
  },
  homepage: "https://github.com/dongitran/saptools/tree/main/packages/service-flow#readme",
  bugs: {
    url: "https://github.com/dongitran/saptools/issues"
  },
  dependencies: {
    commander: "13.1.0",
    picocolors: "1.1.1",
    typescript: "5.9.3",
    zod: "4.4.3"
  },
  devDependencies: {
    "@vitest/coverage-v8": "3.2.4",
    tsup: "8.5.1",
    vitest: "3.2.4"
  }
};

// src/version.ts
var VERSION = package_default.version;
var ANALYZER_VERSION = package_default.version;

// src/db/connection.ts
var sqliteWarningFilterInstalled = false;
function installSqliteWarningFilter() {
  if (sqliteWarningFilterInstalled) return;
  sqliteWarningFilterInstalled = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning, ...args) => {
    const text = warning instanceof Error ? warning.message : String(warning);
    if (text.includes("SQLite is an experimental feature")) return;
    Reflect.apply(original, process, [warning, ...args]);
  });
}
function loadSqlite() {
  try {
    installSqliteWarningFilter();
    const moduleValue = process.getBuiltinModule("node:sqlite");
    if (!moduleValue || typeof moduleValue !== "object" || !("DatabaseSync" in moduleValue))
      throw new Error("node:sqlite DatabaseSync is unavailable");
    const sqlite = moduleValue;
    if (typeof sqlite.DatabaseSync !== "function")
      throw new Error("node:sqlite DatabaseSync is not a constructor");
    return sqlite;
  } catch (error) {
    throw new Error(
      `service-flow ${VERSION} requires Node.js >=24 with node:sqlite DatabaseSync support. Upgrade Node.js or install a service-flow build with a compatible SQLite driver.`,
      { cause: error }
    );
  }
}
function bindParams(params) {
  return params.map((param) => {
    if (param === void 0 || param === null) return null;
    if (typeof param === "string" || typeof param === "number" || typeof param === "bigint" || Buffer.isBuffer(param)) return param;
    if (typeof param === "boolean") return param ? 1 : 0;
    return JSON.stringify(param);
  });
}
function openDatabase(dbPath, options = {}) {
  fs2.mkdirSync(path2.dirname(dbPath), { recursive: true });
  const sqlite = loadSqlite();
  const native = new sqlite.DatabaseSync(dbPath, { readOnly: Boolean(options.readonly) });
  let inTransaction = false;
  const db = {
    path: dbPath,
    readonly: Boolean(options.readonly),
    exec(sql) {
      native.exec(sql);
    },
    prepare(sql) {
      const statement = native.prepare(sql);
      return {
        run: (...params) => statement.run(...bindParams(params)),
        get: (...params) => statement.get(...bindParams(params)),
        all: (...params) => statement.all(...bindParams(params))
      };
    },
    pragma(sql) {
      const normalized = sql.trim().replace(/;$/, "");
      if (/=/.test(normalized)) {
        native.exec(`PRAGMA ${normalized}`);
        return [];
      }
      return native.prepare(`PRAGMA ${normalized}`).all();
    },
    transaction(fn) {
      if (inTransaction) return fn();
      inTransaction = true;
      native.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        native.exec("COMMIT");
        return result;
      } catch (error) {
        native.exec("ROLLBACK");
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    close() {
      native.close();
    }
  };
  db.pragma("busy_timeout = 10000");
  db.pragma("foreign_keys = ON");
  if (!options.readonly) {
    db.pragma("journal_mode = WAL");
    if (options.migrate !== false) migrate(db);
  }
  return db;
}
function openReadOnlyDatabase(dbPath) {
  return openDatabase(dbPath, { readonly: true, migrate: false });
}

// src/db/repositories.ts
function upsertWorkspace(db, rootPath, dbPath) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  db.prepare(
    "INSERT INTO workspaces(root_path,db_path,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(root_path) DO UPDATE SET db_path=excluded.db_path,updated_at=excluded.updated_at"
  ).run(rootPath, dbPath, now, now);
  return Number(
    db.prepare("SELECT id FROM workspaces WHERE root_path=?").get(rootPath)?.id
  );
}
function getWorkspace(db, rootPath) {
  return db.prepare("SELECT * FROM workspaces WHERE root_path=?").get(rootPath);
}
function upsertRepository(db, workspaceId, r) {
  db.prepare(
    `INSERT INTO repositories(workspace_id,name,absolute_path,relative_path,package_name,package_version,dependencies_json,kind,is_git_repo) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,absolute_path) DO UPDATE SET name=excluded.name,relative_path=excluded.relative_path,package_name=excluded.package_name,package_version=excluded.package_version,dependencies_json=excluded.dependencies_json,kind=excluded.kind`
  ).run(
    workspaceId,
    r.name,
    r.absolutePath,
    r.relativePath,
    r.packageName,
    r.packageVersion,
    JSON.stringify(r.dependencies ?? {}),
    r.kind ?? "unknown",
    r.isGitRepo ? 1 : 0
  );
  return Number(
    db.prepare(
      "SELECT id FROM repositories WHERE workspace_id=? AND absolute_path=?"
    ).get(workspaceId, r.absolutePath)?.id
  );
}
function listRepositories(db) {
  return db.prepare("SELECT * FROM repositories ORDER BY name").all();
}
function repoByName(db, name) {
  return db.prepare("SELECT * FROM repositories WHERE name=? OR package_name=?").get(name, name);
}
function clearRepoFacts(db, repoId) {
  for (const t of [
    "cds_requires",
    "cds_services",
    "handler_classes",
    "outbound_calls",
    "symbol_calls",
    "handler_registrations",
    "service_bindings",
    "symbols",
    "diagnostics",
    "files"
  ])
    db.prepare(`DELETE FROM ${t} WHERE repo_id=?`).run(repoId);
  db.prepare("DELETE FROM search_index WHERE repo=?").run(String(repoId));
}
function insertRequires(db, repoId, rows) {
  const stmt = db.prepare(
    "INSERT INTO cds_requires(repo_id,alias,kind,model,destination,service_path,request_timeout,raw_json) VALUES(?,?,?,?,?,?,?,?)"
  );
  for (const r of rows)
    stmt.run(
      repoId,
      r.alias,
      r.kind,
      r.model,
      r.destination,
      r.servicePath,
      r.requestTimeout,
      r.rawJson
    );
}
function insertService(db, repoId, s) {
  const id = Number(
    db.prepare(
      "INSERT INTO cds_services(repo_id,namespace,service_name,qualified_name,service_path,is_extend,source_file,source_line) VALUES(?,?,?,?,?,?,?,?) RETURNING id"
    ).get(
      repoId,
      s.namespace,
      s.serviceName,
      s.qualifiedName,
      s.servicePath,
      s.isExtend ? 1 : 0,
      s.sourceFile,
      s.sourceLine
    )?.id
  );
  const stmt = db.prepare(
    "INSERT INTO cds_operations(service_id,operation_type,operation_name,operation_path,params_json,return_type,source_file,source_line) VALUES(?,?,?,?,?,?,?,?)"
  );
  db.prepare(
    "INSERT INTO search_index(kind,name,path,repo) VALUES(?,?,?,?)"
  ).run("service", s.qualifiedName, s.servicePath, String(repoId));
  for (const o of s.operations)
    stmt.run(
      id,
      o.operationType,
      o.operationName,
      o.operationPath,
      o.paramsJson,
      o.returnType,
      o.sourceFile,
      o.sourceLine
    );
  const search = db.prepare(
    "INSERT INTO search_index(kind,name,path,repo) VALUES(?,?,?,?)"
  );
  for (const o of s.operations)
    search.run("operation", o.operationName, o.operationPath, String(repoId));
  return id;
}
function insertHandler(db, repoId, h) {
  const sid = Number(
    db.prepare(
      "INSERT INTO symbols(repo_id,kind,name,qualified_name,exported,start_line,end_line) VALUES(?,?,?,?,?,?,?) RETURNING id"
    ).get(
      repoId,
      "class",
      h.className,
      h.className,
      1,
      h.sourceLine,
      h.sourceLine
    )?.id
  );
  const hid = Number(
    db.prepare(
      "INSERT INTO handler_classes(repo_id,symbol_id,class_name,source_file,source_line) VALUES(?,?,?,?,?) RETURNING id"
    ).get(repoId, sid, h.className, h.sourceFile, h.sourceLine)?.id
  );
  const stmt = db.prepare(
    "INSERT INTO handler_methods(handler_class_id,method_name,decorator_kind,decorator_value,decorator_raw_expression,source_file,source_line) VALUES(?,?,?,?,?,?,?)"
  );
  for (const m of h.methods)
    stmt.run(
      hid,
      m.methodName,
      m.decoratorKind,
      m.decoratorValue,
      m.decoratorRawExpression,
      m.sourceFile,
      m.sourceLine
    );
  return hid;
}
function insertRegistrations(db, repoId, rows) {
  const stmt = db.prepare(
    "INSERT INTO handler_registrations(repo_id,handler_class_id,class_name,import_source,registration_file,registration_line,registration_kind,confidence) VALUES(?,?,?,?,?,?,?,?)"
  );
  for (const r of rows) {
    const handlerClass = r.className ? db.prepare(
      "SELECT id FROM handler_classes WHERE repo_id=? AND class_name=? ORDER BY id"
    ).all(repoId, r.className) : [];
    stmt.run(
      repoId,
      handlerClass.length === 1 ? handlerClass[0]?.id : null,
      r.className,
      r.importSource,
      r.registrationFile,
      r.registrationLine,
      r.registrationKind,
      r.confidence
    );
  }
}
function insertBindings(db, repoId, rows) {
  const stmt = db.prepare(
    "INSERT INTO service_bindings(repo_id,variable_name,alias,alias_expr,destination_expr,service_path_expr,is_dynamic,placeholders_json,source_file,source_line,helper_chain_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
  );
  for (const r of rows)
    stmt.run(
      repoId,
      r.variableName,
      r.alias,
      r.aliasExpr,
      r.destinationExpr,
      r.servicePathExpr,
      r.isDynamic ? 1 : 0,
      JSON.stringify(r.placeholders),
      r.sourceFile,
      r.sourceLine,
      r.helperChain ? JSON.stringify(r.helperChain) : null
    );
}
function insertExecutableSymbols(db, repoId, rows) {
  const stmt = db.prepare("INSERT INTO symbols(repo_id,file_id,kind,name,qualified_name,exported,start_line,end_line,start_offset,end_offset,source_file,exported_name,evidence_json) VALUES(?,(SELECT id FROM files WHERE repo_id=? AND relative_path=?),?,?,?,?,?,?,?,?,?,?,?)");
  for (const r of rows) stmt.run(repoId, repoId, r.sourceFile, r.kind, r.localName, r.qualifiedName, r.exported ? 1 : 0, r.startLine, r.endLine, r.startOffset, r.endOffset, r.sourceFile, r.exportedName, r.importExportEvidence ? JSON.stringify(r.importExportEvidence) : null);
}
function insertSymbolCalls(db, repoId, rows) {
  const callerStmt = db.prepare("SELECT id FROM symbols WHERE repo_id=? AND source_file=? AND qualified_name=? ORDER BY id LIMIT 1");
  const insertStmt = db.prepare("INSERT INTO symbol_calls(repo_id,caller_symbol_id,callee_symbol_id,callee_expression,import_source,source_file,source_line,status,confidence,evidence_json,unresolved_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  for (const r of rows) {
    const caller = callerStmt.get(repoId, r.sourceFile, r.callerQualifiedName);
    const target = resolveSymbolCallTarget(db, repoId, r);
    insertStmt.run(repoId, caller?.id, target.id, r.calleeExpression, r.importSource, r.sourceFile, r.sourceLine, target.status, 0.8, JSON.stringify({ ...r.evidence, candidateStrategy: target.strategy, candidateCount: target.candidateCount }), target.reason);
  }
}
function isRelativeImportedSymbolCall(r) {
  return Boolean(r.importSource?.startsWith("."));
}
function resolveSymbolCallTarget(db, repoId, r) {
  const evidence = r.evidence;
  const localRows = db.prepare("SELECT id FROM symbols WHERE repo_id=? AND source_file=? AND (name=? OR qualified_name=?) ORDER BY id").all(repoId, r.sourceFile, r.calleeLocalName, r.calleeLocalName);
  if (localRows.length === 1) return { id: localRows[0]?.id ?? null, status: "resolved", reason: null, strategy: "same_file_exact", candidateCount: 1 };
  if (localRows.length > 1) return { id: null, status: "ambiguous", reason: "Multiple same-file symbol targets matched exactly", strategy: "same_file_exact", candidateCount: localRows.length };
  if (evidence.relation === "class_instance_method" && isRelativeImportedSymbolCall(r)) {
    const classRows = db.prepare("SELECT id FROM symbols WHERE repo_id=? AND source_file<>? AND qualified_name=? ORDER BY id").all(repoId, r.sourceFile, r.calleeLocalName);
    if (classRows.length === 1) return { id: classRows[0]?.id ?? null, status: "resolved", reason: null, strategy: "relative_import_class_instance_method", candidateCount: 1 };
    if (classRows.length > 1) return { id: null, status: "ambiguous", reason: "Multiple relative class instance method targets matched exactly", strategy: "relative_import_class_instance_method", candidateCount: classRows.length };
  }
  const rows = db.prepare("SELECT id,kind,evidence_json evidenceJson FROM symbols WHERE repo_id=? AND source_file<>? AND exported=1 AND (exported_name=? OR name=? OR qualified_name=?) ORDER BY id").all(repoId, r.sourceFile, r.calleeLocalName, r.calleeLocalName, r.calleeLocalName);
  if (evidence.relation === "relative_import_proxy_member" && rows.length > 1) {
    const objectMapRows = rows.filter((row) => String(row.evidenceJson ?? "").includes("exported_object_shorthand") || String(row.evidenceJson ?? "").includes("exported_object_literal"));
    if (objectMapRows.length > 0) {
      const concrete = rows.find((row) => row.kind !== "object_alias") ?? objectMapRows[0];
      return { id: concrete?.id ?? null, status: "resolved", reason: null, strategy: "proxy_member_exported_object_map", candidateCount: rows.length };
    }
    return { id: null, status: "ambiguous", reason: "Proxy member target requires explicit factory/module/type evidence; global member name is ambiguous", strategy: "proxy_member_no_global_name_fallback", candidateCount: rows.length };
  }
  if (rows.length === 1) return { id: rows[0]?.id ?? null, status: "resolved", reason: null, strategy: evidence.relation === "relative_import_proxy_member" ? "proxy_member_unique_exported_candidate" : "relative_import_exported_exact", candidateCount: 1 };
  if (rows.length > 1) return { id: null, status: "ambiguous", reason: "Multiple exported symbol targets matched exactly", strategy: "exported_exact", candidateCount: rows.length };
  return { id: null, status: "unresolved", reason: "No local symbol target matched exactly", strategy: evidence.relation === "relative_import_proxy_member" ? "proxy_member_no_global_name_fallback" : "exact_symbol_match", candidateCount: 0 };
}
function insertCalls(db, repoId, rows) {
  const stmt = db.prepare(
    "INSERT INTO outbound_calls(repo_id,source_symbol_id,call_type,method,operation_path_expr,query_entity,event_name_expr,payload_summary,source_file,source_line,confidence,unresolved_reason,local_service_name,local_service_lookup,alias_chain_json,evidence_json,external_target_kind,external_target_id,external_target_label,external_target_dynamic,service_binding_id) VALUES(?,COALESCE((SELECT id FROM symbols WHERE repo_id=? AND source_file=? AND qualified_name=? ORDER BY id LIMIT 1),(SELECT id FROM symbols WHERE repo_id=? AND source_file=? AND start_line<=? AND end_line>=? ORDER BY (end_line-start_line),id LIMIT 1)),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,(SELECT id FROM service_bindings WHERE repo_id=? AND variable_name=? AND source_file=? ORDER BY CASE WHEN source_line<=? THEN 0 ELSE 1 END, ABS(source_line-?) ASC, id DESC LIMIT 1))"
  );
  for (const r of rows)
    stmt.run(
      repoId,
      repoId,
      r.sourceFile,
      r.sourceSymbolQualifiedName,
      repoId,
      r.sourceFile,
      r.sourceLine,
      r.sourceLine,
      r.callType,
      r.method,
      r.operationPathExpr,
      r.queryEntity,
      r.eventNameExpr,
      r.payloadSummary,
      r.sourceFile,
      r.sourceLine,
      r.confidence,
      r.unresolvedReason,
      r.localServiceName,
      r.localServiceLookup,
      r.aliasChain ? JSON.stringify(r.aliasChain) : null,
      r.evidence ? JSON.stringify(r.evidence) : null,
      r.externalTarget?.kind ?? null,
      r.externalTarget?.stableId ?? null,
      r.externalTarget?.label ?? null,
      r.externalTarget?.dynamic ? 1 : 0,
      repoId,
      r.serviceVariableName,
      r.sourceFile,
      r.sourceLine,
      r.sourceLine
    );
}

// src/discovery/classify-repository.ts
import fs3 from "fs/promises";
import path3 from "path";
async function classifyRepository(repoPath, facts) {
  const hasCdsDep = Boolean(
    facts.dependencies["@sap/cds"] ?? facts.dependencies.cds ?? facts.dependencies["cds-routing-handlers"]
  );
  const cdsFiles = await findFiles(repoPath, ".cds");
  const serverFiles = await Promise.all(
    ["srv/server.ts", "srv/server.js", "src/server.ts", "src/server.js"].map(
      async (f) => fs3.access(path3.join(repoPath, f)).then(() => true).catch(() => false)
    )
  );
  const helper = Object.keys(facts.dependencies).includes("cds-routing-handlers") || facts.packageName?.includes("helper") === true;
  if (helper && cdsFiles.length > 0) return "mixed";
  if (helper) return "helper-package";
  if (hasCdsDep && (cdsFiles.length > 0 || serverFiles.some(Boolean)))
    return "cap-service";
  if (cdsFiles.length > 0)
    return serverFiles.some(Boolean) ? "cap-service" : "cap-db-model";
  return "unknown";
}
async function findFiles(root, suffix) {
  const out = [];
  async function walk(dir) {
    const entries = await fs3.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!["node_modules", "dist", "gen", ".git"].includes(e.name))
          await walk(path3.join(dir, e.name));
      } else if (e.name.endsWith(suffix)) out.push(path3.join(dir, e.name));
    }
  }
  await walk(root);
  return out;
}

// src/utils/diagnostics.ts
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/indexer/repository-indexer.ts
import fs5 from "fs/promises";
import path5 from "path";

// src/parsers/symbol-parser.ts
import fs4 from "fs/promises";
import path4 from "path";
import ts from "typescript";
function lineOf(source, pos) {
  return source.getLineAndCharacterOfPosition(pos).line + 1;
}
function nameOf(node) {
  if (!node) return void 0;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return void 0;
}
function isFunctionLike(node) {
  return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}
function exported(node) {
  return Boolean(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export);
}
function isPublicClassMethod(node) {
  const flags = ts.getCombinedModifierFlags(node);
  return (flags & ts.ModifierFlags.Private) === 0 && (flags & ts.ModifierFlags.Protected) === 0;
}
function exportDeclarations(source) {
  const exports = /* @__PURE__ */ new Map();
  const visit = (node) => {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) exports.set((el.propertyName ?? el.name).text, el.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return exports;
}
function isRelativeImport(value) {
  return Boolean(value?.startsWith("."));
}
function isObjectFunction(node) {
  return ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}
var commonTerminalMembers = /* @__PURE__ */ new Set(["push", "includes", "find", "findIndex", "map", "filter", "reduce", "forEach", "some", "every", "toUpperCase", "toLowerCase", "trim", "split", "join", "get", "set", "has"]);
var loggerMembers = /* @__PURE__ */ new Set(["trace", "debug", "info", "warn", "error", "fatal", "log"]);
var globalObjects = /* @__PURE__ */ new Set(["JSON", "Object", "Array", "String", "Number", "Boolean", "Math", "Date", "Promise", "Reflect"]);
var builtInConstructors = /* @__PURE__ */ new Set([
  "Set",
  "Map",
  "WeakSet",
  "WeakMap",
  "Date",
  "RegExp",
  "URL",
  "URLSearchParams",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "Promise",
  "AbortController"
]);
var capDslRoots = /* @__PURE__ */ new Set(["SELECT", "INSERT", "UPSERT", "UPDATE", "DELETE"]);
var requestHelpers = /* @__PURE__ */ new Set(["reject", "error", "info", "warn", "notify"]);
var transportMembers = /* @__PURE__ */ new Set(["emit", "publish", "send", "on"]);
function callName(expr) {
  if (ts.isIdentifier(expr)) return { expression: expr.text, local: expr.text };
  if (ts.isPropertyAccessExpression(expr)) {
    const left = expr.expression.getText();
    const root = left.split(".")[0];
    return { expression: expr.getText(), local: left === "this" ? void 0 : root, member: expr.name.text, receiver: left };
  }
  return { expression: expr.getText() };
}
function requireSource(expr) {
  if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression) || expr.expression.text !== "require") return void 0;
  const first = expr.arguments[0];
  return first && ts.isStringLiteral(first) ? first.text : void 0;
}
function ignoredFrameworkCall(callee) {
  if (callee.local && capDslRoots.has(callee.local)) return true;
  if (callee.expression === "cds.run" || callee.expression.startsWith("cds.connect.") || callee.expression.startsWith("cds.services.") || callee.expression.startsWith("cds.parse.")) return true;
  if (callee.local === "req" && callee.member && requestHelpers.has(callee.member)) return true;
  if (callee.member && transportMembers.has(callee.member)) return true;
  if (callee.local && globalObjects.has(callee.local)) return true;
  if (callee.expression.startsWith("new Date().")) return true;
  return false;
}
function nearest(symbols, line) {
  return symbols.filter((s) => s.startLine <= line && s.endLine >= line).sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
}
function argumentEvidence(args, source) {
  return args.map((arg) => {
    if (ts.isIdentifier(arg)) return { kind: "identifier", name: arg.text };
    if (ts.isObjectLiteralExpression(arg)) {
      const properties = [];
      for (const prop of arg.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) properties.push({ kind: "shorthand", property: prop.name.text, argument: prop.name.text });
        if (ts.isPropertyAssignment(prop)) {
          const propName = nameOf(prop.name);
          if (propName && ts.isIdentifier(prop.initializer)) properties.push({ kind: "property_assignment", property: propName, argument: prop.initializer.text });
        }
      }
      return { kind: "object_literal", properties };
    }
    return { kind: "unsupported", expression: arg.getText(source) };
  });
}
function bindingLocalName(name, initializer) {
  if (ts.isIdentifier(name)) return name.text;
  if (initializer && ts.isIdentifier(initializer)) return initializer.text;
  return void 0;
}
function objectPatternAliases(pattern, parameter, source, lineNode) {
  return pattern.elements.flatMap((element) => {
    if (element.dotDotDotToken || ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) return [];
    const property = element.propertyName ? nameOf(element.propertyName) : nameOf(element.name);
    if (!property) return [];
    const local = bindingLocalName(element.name, element.initializer);
    return local ? [{ parameter, property, local, kind: "object_parameter_destructure", line: lineOf(source, lineNode.getStart(source)) }] : [];
  });
}
function parameterPropertyAliases(fn, source) {
  const parameterNames = new Set(fn.parameters.flatMap((param) => ts.isIdentifier(param.name) ? [param.name.text] : []));
  if (!fn.body || parameterNames.size === 0) return [];
  const aliases = [];
  const addFromAssignment = (left, right, node) => {
    if (!ts.isObjectLiteralExpression(left) || !ts.isIdentifier(right) || !parameterNames.has(right.text)) return;
    for (const prop of left.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const property = nameOf(prop.name);
      if (property && ts.isIdentifier(prop.initializer)) aliases.push({ parameter: right.text, property, local: prop.initializer.text, kind: "object_parameter_destructure", line: lineOf(source, node.getStart(source)) });
    }
  };
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && ts.isIdentifier(node.initializer) && parameterNames.has(node.initializer.text)) aliases.push(...objectPatternAliases(node.name, node.initializer.text, source, node));
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) addFromAssignment(ts.isParenthesizedExpression(node.left) ? node.left.expression : node.left, node.right, node);
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  const seen = /* @__PURE__ */ new Set();
  return aliases.filter((alias) => {
    const key = `${alias.parameter}.${alias.property}:${alias.local}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function parameterBindings(params) {
  return params.flatMap((param, index) => {
    if (ts.isIdentifier(param.name)) return [{ index, kind: "identifier", name: param.name.text }];
    if (!ts.isObjectBindingPattern(param.name)) return [];
    const properties = param.name.elements.flatMap((element) => {
      if (element.dotDotDotToken || ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) return [];
      const property = element.propertyName ? nameOf(element.propertyName) : nameOf(element.name);
      if (!property) return [];
      const local = bindingLocalName(element.name, element.initializer);
      return local ? [{ property, local }] : [];
    });
    return properties.length > 0 ? [{ index, kind: "object_pattern", properties }] : [];
  });
}
async function parseExecutableSymbols(repoPath, filePath) {
  const text = await fs4.readFile(path4.join(repoPath, filePath), "utf8");
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, filePath.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const sourceFile = normalizePath(filePath);
  const symbols = [];
  const calls = [];
  const imports = /* @__PURE__ */ new Map();
  const exportNames = exportDeclarations(source);
  const objectExports = /* @__PURE__ */ new Set();
  const exportedClasses = /* @__PURE__ */ new Set();
  const declaredClasses = /* @__PURE__ */ new Set();
  const proxyVariables = /* @__PURE__ */ new Map();
  const classInstances = /* @__PURE__ */ new Map();
  const addSymbol = (kind, localName, node, parentName, exportedName, evidence) => {
    const parentRoot = parentName?.split(".")[0] ?? "";
    const declaredExportName = exportedName ?? exportNames.get(parentName ? parentRoot : localName);
    const qualifiedName = parentName ? `${parentName}.${localName}` : localName;
    const objectExported = parentName ? objectExports.has(parentRoot) : false;
    const classMemberExported = kind === "method" && parentName ? exportedClasses.has(parentRoot) && ts.isMethodDeclaration(node) && (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Static) !== 0 && isPublicClassMethod(node) : false;
    const effectiveExportedName = classMemberExported || objectExported ? qualifiedName : declaredExportName;
    const bindings = isFunctionLike(node) ? parameterBindings(node.parameters) : void 0;
    const params = bindings?.flatMap((binding) => binding.kind === "identifier" ? [binding.name] : []);
    const sourceEvidence = evidence ?? (classMemberExported ? { source: "exported_class_member", exportedClass: parentRoot, memberKind: (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Static) !== 0 ? "static_method" : "class_method", parameters: params } : declaredExportName ? { exportedName: declaredExportName, source: "export_declaration" } : objectExported ? { exportedName: qualifiedName, source: "exported_object_literal" } : void 0);
    const aliases = isFunctionLike(node) ? parameterPropertyAliases(node, source) : [];
    const parameterEvidence = { ...bindings && bindings.length > 0 ? { parameters: params, parameterBindings: bindings } : {}, ...aliases.length > 0 ? { parameterPropertyAliases: aliases } : {} };
    symbols.push({ kind, localName: kind === "object_method" ? qualifiedName : localName, exportedName: effectiveExportedName, qualifiedName, sourceFile, startLine: lineOf(source, node.getStart(source)), endLine: lineOf(source, node.getEnd()), startOffset: node.getStart(source), endOffset: node.getEnd(), exported: exported(node) || Boolean(effectiveExportedName), importExportEvidence: sourceEvidence ? { ...sourceEvidence, ...parameterEvidence } : bindings && bindings.length > 0 ? parameterEvidence : void 0 });
  };
  const addAliasSymbol = (objectName, propertyName, node, targetImportSource) => {
    symbols.push({ kind: "object_alias", localName: propertyName, exportedName: propertyName, qualifiedName: `${objectName}.${propertyName}`, sourceFile, startLine: lineOf(source, node.getStart(source)), endLine: lineOf(source, node.getEnd()), startOffset: node.getStart(source), endOffset: node.getEnd(), exported: true, importExportEvidence: { source: "exported_object_shorthand", objectName, propertyName, targetImportSource } });
  };
  const visitImports = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const sourceText = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause?.name) imports.set(clause.name.text, sourceText);
      const named = clause?.namedBindings;
      if (named && ts.isNamedImports(named)) for (const el of named.elements) imports.set(el.name.text, sourceText);
      if (named && ts.isNamespaceImport(named)) imports.set(named.name.text, sourceText);
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        const requiredSource = declaration.initializer ? requireSource(declaration.initializer) : void 0;
        if (ts.isIdentifier(declaration.name) && requiredSource) imports.set(declaration.name.text, requiredSource);
        if (ts.isObjectBindingPattern(declaration.name) && requiredSource) {
          for (const element of declaration.name.elements) if (ts.isIdentifier(element.name)) imports.set(element.name.text, requiredSource);
        }
      }
    }
    ts.forEachChild(node, visitImports);
  };
  visitImports(source);
  const visitSymbols = (node, parentClass) => {
    if (ts.isClassDeclaration(node) && node.name) {
      declaredClasses.add(node.name.text);
      if (exported(node) || exportNames.has(node.name.text)) exportedClasses.add(node.name.text);
      for (const member of node.members) visitSymbols(member, node.name.text);
      return;
    }
    if (ts.isMethodDeclaration(node)) {
      const localName = nameOf(node.name);
      if (localName) addSymbol("method", localName, node, parentClass);
    } else if (ts.isPropertyDeclaration(node) && parentClass && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      const localName = nameOf(node.name);
      if (localName) addSymbol("method", localName, node.initializer, parentClass, void 0, { source: "class_property_function", memberKind: ts.isArrowFunction(node.initializer) ? "arrow_function_property" : "function_expression_property" });
    } else if (ts.isFunctionDeclaration(node) && node.name) addSymbol("function", node.name.text, node, void 0, exported(node) ? node.name.text : void 0);
    else if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        const localName = nameOf(d.name);
        if (!localName || !d.initializer) continue;
        if (isFunctionLike(d.initializer)) addSymbol("function", localName, d.initializer, void 0, exported(node) ? localName : exportNames.get(localName));
        if (ts.isObjectLiteralExpression(d.initializer)) {
          const objectIsExported = exported(node) || exportNames.has(localName);
          if (objectIsExported) objectExports.add(localName);
          for (const prop of d.initializer.properties) {
            if (objectIsExported && ts.isShorthandPropertyAssignment(prop)) addAliasSymbol(localName, prop.name.text, prop.name, imports.get(prop.name.text));
            if (ts.isPropertyAssignment(prop) && isObjectFunction(prop.initializer)) {
              const propName = nameOf(prop.name);
              if (propName) addSymbol("object_method", propName, prop.initializer, localName);
            } else if (ts.isMethodDeclaration(prop)) {
              const propName = nameOf(prop.name);
              if (propName) addSymbol("object_method", propName, prop, localName);
            }
          }
        }
      }
    } else ts.forEachChild(node, (child) => visitSymbols(child, parentClass));
  };
  visitSymbols(source);
  const isTopLevelCallback = (node) => {
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
    if (!ts.isCallExpression(node.parent)) return false;
    const callee = callName(node.parent.expression);
    const member = callee.member ?? callee.local;
    return Boolean(member && ["bootstrap", "served", "connect", "on", "once", "use", "get", "post", "put", "patch", "delete", "subscribe"].includes(member));
  };
  const visitCallbackSymbols = (node) => {
    if (isTopLevelCallback(node) && containsSupportedOutboundCall(node)) {
      const startLine = lineOf(source, node.getStart(source));
      const name = `callback:${startLine}`;
      symbols.push({ kind: "callback", localName: name, qualifiedName: `module:${sourceFile}#${name}`, sourceFile, startLine, endLine: lineOf(source, node.getEnd()), startOffset: node.getStart(source), endOffset: node.getEnd(), exported: false, importExportEvidence: { source: "synthetic_outbound_callback", callbackLine: startLine } });
    }
    ts.forEachChild(node, visitCallbackSymbols);
  };
  visitCallbackSymbols(source);
  const visitEventRegistrationSymbols = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "on") {
      const receiver = node.expression.expression.getText(source);
      const eventArg = node.arguments[0];
      if ((receiver === "cds" || /^(srv|service|serviceClient|messaging|messageClient|eventClient|.*Client)$/.test(receiver)) && eventArg && (ts.isStringLiteral(eventArg) || ts.isNoSubstitutionTemplateLiteral(eventArg))) {
        const startLine = lineOf(source, node.getStart(source));
        const eventName = eventArg.text.replace(/[^A-Za-z0-9_$-]/g, "_");
        const name = `event:${eventName}:${startLine}`;
        symbols.push({ kind: "event_registration", localName: name, qualifiedName: `module:${sourceFile}#${name}`, sourceFile, startLine, endLine: lineOf(source, node.getEnd()), startOffset: node.getStart(source), endOffset: node.getEnd(), exported: false, importExportEvidence: { source: "synthetic_event_registration", eventName: eventArg.text, registrationLine: startLine, receiver } });
      }
    }
    ts.forEachChild(node, visitEventRegistrationSymbols);
  };
  visitEventRegistrationSymbols(source);
  const visitProxyVariables = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && ts.isPropertyAccessExpression(node.initializer.expression)) {
      const callee = callName(node.initializer.expression);
      const importSource = callee.local ? imports.get(callee.local) : void 0;
      if (callee.member && importSource && isRelativeImport(importSource)) proxyVariables.set(node.name.text, { importSource, factory: callee.expression, variableName: node.name.text });
    }
    ts.forEachChild(node, visitProxyVariables);
  };
  visitProxyVariables(source);
  const rememberClassInstance = (variableName, className, propertyName) => {
    const importSource = imports.get(className);
    if (!builtInConstructors.has(className) && (importSource && isRelativeImport(importSource) || declaredClasses.has(className))) classInstances.set(variableName, { className, importSource, propertyName });
  };
  const visitClassInstances = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isNewExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)) {
      rememberClassInstance(node.name.text, node.initializer.expression.text);
    }
    if (ts.isPropertyDeclaration(node) && node.initializer && ts.isNewExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)) {
      const propertyName = nameOf(node.name);
      if (propertyName) rememberClassInstance(`this.${propertyName}`, node.initializer.expression.text, propertyName);
    }
    ts.forEachChild(node, visitClassInstances);
  };
  visitClassInstances(source);
  const localCallables = new Set(symbols.flatMap((sym) => [sym.localName, sym.qualifiedName]));
  const visitCalls = (node) => {
    if (ts.isCallExpression(node)) {
      const line = lineOf(source, node.getStart(source));
      const caller = nearest(symbols, line);
      if (caller) {
        const callee = callName(node.expression);
        const proxy = callee.local ? proxyVariables.get(callee.local) : void 0;
        const instance = (callee.local ? classInstances.get(callee.local) : void 0) ?? (callee.receiver ? classInstances.get(callee.receiver) : void 0);
        const importSource = instance?.importSource ?? proxy?.importSource ?? (callee.local ? imports.get(callee.local) : void 0) ?? (callee.member && callee.local ? imports.get(callee.local) : void 0);
        const directThisMethod = callee.receiver === "this";
        const targetName = instance && callee.member ? `${instance.className}.${callee.member}` : proxy && callee.member ? callee.member : directThisMethod ? callee.member : callee.member && callee.local ? `${callee.local}.${callee.member}` : callee.local;
        const className = caller.qualifiedName.includes(".") ? caller.qualifiedName.split(".")[0] : void 0;
        const thisTarget = directThisMethod && className && callee.member ? `${className}.${callee.member}` : void 0;
        const loggerLike = callee.receiver?.endsWith(".logger") || callee.local === "logger" || (callee.expression.startsWith("this.logger.") && callee.member ? loggerMembers.has(callee.member) : false);
        const terminalMember = callee.member ? commonTerminalMembers.has(callee.member) || loggerMembers.has(callee.member) : false;
        const provenLocal = Boolean(targetName) && localCallables.has(String(targetName));
        const provenThisMethod = Boolean(thisTarget && localCallables.has(thisTarget));
        const provenRelativeImport = Boolean(isRelativeImport(importSource) && targetName);
        const provenClassInstance = Boolean(instance && callee.member && targetName);
        const importedFromPackage = Boolean(importSource && !isRelativeImport(importSource));
        const ignored = loggerLike || terminalMember || importedFromPackage || ignoredFrameworkCall(callee);
        const resolvedTarget = provenThisMethod ? thisTarget : targetName;
        const keep = Boolean(resolvedTarget) && !ignored && (provenLocal || provenThisMethod || provenRelativeImport || provenClassInstance);
        if (keep) calls.push({ callerQualifiedName: caller.qualifiedName, calleeExpression: callee.expression, calleeLocalName: resolvedTarget, receiverLocalName: callee.member ? callee.local ?? callee.receiver : void 0, importSource, sourceFile, sourceLine: line, evidence: { relation: instance ? "class_instance_method" : proxy ? "relative_import_proxy_member" : importSource ? "relative_import" : provenThisMethod ? "indexed_this_method" : "indexed_local_symbol", caller: caller.qualifiedName, targetName: resolvedTarget, instanceVariable: instance ? instance.propertyName ?? callee.local : void 0, className: instance?.className, methodName: instance ? callee.member : void 0, classImportSource: instance?.importSource, callArguments: argumentEvidence(node.arguments, source), proxyVariableName: proxy?.variableName, factory: proxy?.factory, factoryExpression: proxy?.factory, factoryImportSource: proxy?.importSource, candidateStrategy: instance ? instance.importSource ? "relative_import_class_instance_method" : "same_file_class_instance_method" : proxy ? "proxy_member_exact_export_or_unique_member" : void 0 } });
      }
    }
    ts.forEachChild(node, visitCalls);
  };
  visitCalls(source);
  return { symbols, calls };
}

// src/utils/hashing.ts
import { createHash } from "crypto";
import { readFile } from "fs/promises";
async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}
function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

// src/indexer/repository-indexer.ts
async function indexRepository(db, repo, force) {
  try {
    const sourceFiles = await findSourceFiles(repo.absolute_path);
    const packageFacts = await parsePackageJson(repo.absolute_path);
    const fingerprint = await repositoryFingerprint(repo.absolute_path, sourceFiles, packageFacts);
    if (!force && repo.fingerprint === fingerprint) return { fileCount: 0, diagnosticCount: 0, skipped: true };
    const kind = await classifyRepository(repo.absolute_path, packageFacts);
    const parsed = await parseAllSourceFacts(repo.absolute_path, sourceFiles);
    db.transaction(() => {
      db.prepare("UPDATE repositories SET package_name=?, package_version=?, dependencies_json=?, kind=?, index_status=? WHERE id=?").run(packageFacts.packageName, packageFacts.packageVersion, JSON.stringify(packageFacts.dependencies), kind, "indexing", repo.id);
      clearRepoFacts(db, repo.id);
      insertRequires(db, repo.id, packageFacts.cdsRequires);
      const fileStmt = db.prepare("INSERT INTO files(repo_id,relative_path,extension,sha256,size_bytes,last_indexed_at) VALUES(?,?,?,?,?,?) ON CONFLICT(repo_id,relative_path) DO UPDATE SET sha256=excluded.sha256,size_bytes=excluded.size_bytes,last_indexed_at=excluded.last_indexed_at");
      for (const file of parsed.fileRecords) fileStmt.run(repo.id, file.relativePath, file.extension, file.sha256, file.sizeBytes, (/* @__PURE__ */ new Date()).toISOString());
      for (const s of parsed.services) insertService(db, repo.id, s);
      for (const h of parsed.handlers) insertHandler(db, repo.id, h);
      insertExecutableSymbols(db, repo.id, parsed.symbols);
      insertSymbolCalls(db, repo.id, parsed.symbolCalls);
      insertRegistrations(db, repo.id, parsed.registrations);
      insertBindings(db, repo.id, parsed.bindings);
      insertCalls(db, repo.id, parsed.calls);
      db.prepare("UPDATE repositories SET last_indexed_at=?, index_status='indexed', error_count=0, fingerprint=?, fact_generation=COALESCE(fact_generation,0)+1, graph_stale_reason='facts_changed', graph_stale_at=? WHERE id=?").run((/* @__PURE__ */ new Date()).toISOString(), fingerprint, (/* @__PURE__ */ new Date()).toISOString(), repo.id);
    });
    return { fileCount: sourceFiles.length, diagnosticCount: 0, skipped: false };
  } catch (error) {
    const message = errorMessage(error);
    db.prepare("UPDATE repositories SET index_status='failed', error_count=1 WHERE id=?").run(repo.id);
    db.prepare("DELETE FROM diagnostics WHERE repo_id=? AND code IN ('index_failed_snapshot_preserved','source_read_failed')").run(repo.id);
    db.prepare("INSERT INTO diagnostics(repo_id,severity,code,message) VALUES(?,?,?,?)").run(repo.id, "error", "source_read_failed", `Index failed before publication; previous facts and fingerprint were preserved. ${message}`);
    return { fileCount: 0, diagnosticCount: 1, skipped: false };
  }
}
async function parseAllSourceFacts(root, files) {
  const facts = { services: [], handlers: [], registrations: [], bindings: [], calls: [], symbols: [], symbolCalls: [], fileRecords: [] };
  for (const file of files) {
    const abs = path5.join(root, file);
    const stat = await fs5.stat(abs);
    facts.fileRecords.push({ relativePath: normalizePath(file), extension: path5.extname(file), sha256: await sha256File(abs), sizeBytes: stat.size });
    if (file.endsWith(".cds")) facts.services.push(...await parseCdsFile(root, file));
    if (/\.[jt]s$/.test(file)) {
      facts.handlers.push(...await parseDecorators(root, file));
      facts.registrations.push(...await parseHandlerRegistrations(root, file));
      facts.bindings.push(...await parseServiceBindings(root, file));
      const symbolFacts = await parseExecutableSymbols(root, file);
      facts.symbols.push(...symbolFacts.symbols);
      facts.symbolCalls.push(...symbolFacts.calls);
      facts.calls.push(...await parseOutboundCalls(root, file));
    }
  }
  return facts;
}
async function findSourceFiles(root) {
  const out = [];
  async function walk(dir, prefix = "") {
    const entries = await fs5.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!["node_modules", "dist", "gen", "coverage", ".git"].includes(e.name)) await walk(path5.join(dir, e.name), rel);
      } else if (/\.(cds|ts|js)$/.test(e.name) && !isDefaultTestFile(rel)) out.push(rel);
    }
  }
  await walk(root);
  return out.sort();
}
function isDefaultTestFile(relativeFile) {
  const parts = relativeFile.split("/");
  if (parts.some((part) => ["test", "tests", "__tests__"].includes(part))) return true;
  return /\.(test|spec)\.[jt]s$/.test(parts.at(-1) ?? "");
}
async function repositoryFingerprint(root, files, facts) {
  const packageJson = await fs5.readFile(path5.join(root, "package.json"), "utf8").catch(() => "");
  const normalizedFacts = {
    analyzerVersion: ANALYZER_VERSION,
    packageName: facts.packageName,
    packageVersion: facts.packageVersion,
    dependencies: Object.fromEntries(Object.entries(facts.dependencies).sort()),
    cdsRequires: [...facts.cdsRequires].sort((a, b) => a.alias.localeCompare(b.alias)),
    scripts: Object.fromEntries(Object.entries(facts.scripts).sort()),
    includeTests: false,
    packageJsonHash: sha256Text(packageJson)
  };
  const entries = [`facts:${JSON.stringify(normalizedFacts)}`];
  for (const file of files) {
    const content = await fs5.readFile(path5.join(root, file), "utf8");
    entries.push(`${file}:${sha256Text(content)}`);
  }
  return sha256Text(entries.join("\n"));
}

// src/indexer/workspace-indexer.ts
async function indexWorkspace(db, workspaceId, options) {
  const started = (/* @__PURE__ */ new Date()).toISOString();
  const repos = options.repo ? [repoByName(db, options.repo)].filter((r) => r !== void 0) : listRepositories(db);
  const runId = Number(db.prepare("INSERT INTO index_runs(workspace_id,started_at,status,repo_count,file_count,diagnostic_count) VALUES(?,?,?,?,?,?) RETURNING id").get(workspaceId, started, "running", repos.length, 0, 0)?.id);
  let fileCount = 0;
  let diagnosticCount = 0;
  let skippedCount = 0;
  try {
    for (const repo of repos) {
      const result = await indexRepository(db, repo, options.force);
      fileCount += result.fileCount;
      diagnosticCount += result.diagnosticCount;
      skippedCount += result.skipped ? 1 : 0;
    }
    db.prepare("UPDATE index_runs SET finished_at=?, status=?, file_count=?, diagnostic_count=? WHERE id=?").run((/* @__PURE__ */ new Date()).toISOString(), diagnosticCount ? "failed" : "success", fileCount, diagnosticCount, runId);
    return { repoCount: repos.length, indexedCount: repos.length - skippedCount, skippedCount, fileCount, diagnosticCount };
  } catch (error) {
    db.prepare("UPDATE index_runs SET finished_at=?, status='failed', file_count=?, diagnostic_count=?, error_message=? WHERE id=?").run((/* @__PURE__ */ new Date()).toISOString(), fileCount, diagnosticCount + 1, errorMessage(error), runId);
    throw error;
  }
}

// src/trace/selectors.ts
function parseVars(values) {
  const out = {};
  for (const value of values ?? []) {
    const [key, ...rest] = value.split("=");
    if (key && rest.length > 0) out[key] = rest.join("=");
  }
  return out;
}

// src/output/table-output.ts
function location(evidence) {
  const file = evidence.file ?? evidence.sourceFile ?? evidence.handlerSourceFile ?? evidence.operationSourceFile ?? evidence.registrationSourceFile;
  const line = evidence.line ?? evidence.sourceLine ?? evidence.handlerSourceLine ?? evidence.operationSourceLine ?? evidence.registrationSourceLine;
  if (file || line) return `${String(file ?? "")}:${String(line ?? "")}`;
  const candidates = evidence.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    const first = candidates[0];
    return `${String(first.sourceFile ?? "")}:${String(first.sourceLine ?? "")}`;
  }
  return ":";
}
function renderTraceTable(result) {
  const lines = ["Step  Type                 From                                To                                  Evidence"];
  for (const e of result.edges) {
    lines.push(`${String(e.step).padEnd(5)} ${e.type.padEnd(20)} ${e.from.slice(0, 34).padEnd(35)} ${e.to.slice(0, 35).padEnd(36)} ${location(e.evidence)}`);
  }
  if (result.diagnostics.length > 0) lines.push("", "Diagnostics:", ...result.diagnostics.map((d) => `${String(d.severity ?? "info")} ${String(d.code ?? "diagnostic")} ${String(d.message ?? "")}`));
  return `${lines.join("\n")}
`;
}

// src/output/json-output.ts
function renderJson(value) {
  return `${JSON.stringify(value, null, 2)}
`;
}
function renderTraceJson(trace2) {
  return renderJson(trace2);
}

// src/output/mermaid-output.ts
function safe(value) {
  return value.replace(/[^\w-]/g, "_").slice(0, 60);
}
function label(trace2, idOrLabel) {
  const node = trace2.nodes.find((item) => item.id === idOrLabel || item.label === idOrLabel);
  return String(node?.label ?? idOrLabel);
}
function renderMermaid(trace2) {
  const lines = ["flowchart TD"];
  for (const e of trace2.edges)
    lines.push(
      `  ${safe(e.from)}["${label(trace2, e.from)}"] -->|${e.type}| ${safe(e.to)}["${label(trace2, e.to)}"]`
    );
  return `${lines.join("\n")}
`;
}

// src/cli.ts
async function init(workspace, options) {
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
    `Workspace: ${config.rootPath}
Database: ${config.dbPath}
Repositories: ${repos.length}
Ignored: ${config.ignore.join(", ")}
Next: service-flow index --workspace ${config.rootPath}
`
  );
}
async function withWorkspace(workspace, fn) {
  const config = await loadWorkspaceConfig(workspace);
  const db = openDatabase(config.dbPath);
  try {
    const row = getWorkspace(db, config.rootPath);
    const workspaceId = row?.id ?? upsertWorkspace(db, config.rootPath, config.dbPath);
    return await fn(db, workspaceId, config.rootPath);
  } finally {
    db.close();
  }
}
async function withReadOnlyWorkspace(workspace, fn) {
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
function schemaDriftDiagnostics(db, strict) {
  if (!strict) return [];
  const symbolColumns = db.prepare("PRAGMA table_info(symbols)").all();
  const legacy = symbolColumns.filter((row) => ["external_target_kind", "external_target_id", "external_target_label", "external_target_dynamic"].includes(String(row.name))).map((row) => row.name);
  const missingExternal = db.prepare("SELECT id id,source_file sourceFile,source_line sourceLine FROM outbound_calls WHERE call_type='external_http' AND (external_target_id IS NULL OR external_target_label IS NULL OR external_target_kind IS NULL) LIMIT 20").all();
  const diagnostics = [];
  if (legacy.length > 0) diagnostics.push({ severity: "warning", code: "schema_legacy_columns_present", message: "Legacy external-target columns are present on symbols; run service-flow clean --db-only, then init/index/link to rebuild with the current schema.", scope: "workspace", affectedColumns: legacy, remediation: "service-flow clean --db-only && service-flow init <workspace> && service-flow index && service-flow link" });
  if (missingExternal.length > 0) diagnostics.push({ severity: "warning", code: "external_target_columns_missing_data", message: "External HTTP calls are missing queryable external target metadata; reindex is required after upgrade.", scope: "workspace", affectedRows: missingExternal, remediation: "service-flow index --force && service-flow link" });
  if (legacy.length > 0 || missingExternal.length > 0) diagnostics.push({ severity: "warning", code: "reindex_required_after_upgrade", message: "This database cannot be made equivalent to a fresh index by relink alone.", scope: "workspace", remediation: "Rebuild or force reindex the workspace, then run service-flow doctor --strict." });
  return diagnostics;
}
function linkUpgradeWarnings(db) {
  return schemaDriftDiagnostics(db, true).filter((item) => ["schema_legacy_columns_present", "external_target_columns_missing_data", "reindex_required_after_upgrade"].includes(String(item.code)));
}
function localServiceDiagnostics(db, strict) {
  const rows = db.prepare(`SELECT e.status status,e.unresolved_reason reason,e.evidence_json evidenceJson FROM graph_edges e JOIN outbound_calls c ON e.from_kind='call' AND c.id=CAST(e.from_id AS INTEGER) WHERE c.call_type='local_service_call'`).all();
  const implementationContext = rows.filter((row) => row.status === "resolved" && String(row.evidenceJson ?? "").includes("implementation_context_caller_ownership")).length;
  const withoutOwnership = rows.filter((row) => row.reason === "local_service_candidate_without_caller_ownership" || String(row.evidenceJson ?? "").includes("local_service_candidate_without_caller_ownership")).length;
  const unresolved = rows.filter((row) => row.status === "unresolved").length;
  const outsideScope = rows.filter((row) => {
    if (row.status !== "unresolved") return false;
    try {
      const evidence = JSON.parse(String(row.evidenceJson ?? "{}"));
      return Number(evidence.candidateCount ?? 0) > 0;
    } catch {
      return false;
    }
  }).length;
  const out = [];
  if (withoutOwnership > 0) out.push({ severity: "warning", code: "local_service_candidate_without_caller_ownership", message: `Local service calls have operation candidates but no caller ownership evidence: ${withoutOwnership}` });
  if (outsideScope > 0) out.push({ severity: "warning", code: "local_service_candidates_outside_local_scope", message: `Local service calls found candidates outside same-repository scope: ${outsideScope}` });
  if (strict && unresolved > 0) out.push({ severity: "warning", code: "local_service_calls_unresolved", message: `Unresolved local service calls: ${unresolved}` });
  if (strict && implementationContext > 0) out.push({ severity: "info", code: "local_service_calls_resolved_by_implementation_context", message: `Local service calls resolved by implementation-context ownership: ${implementationContext}` });
  return out;
}
function parserQualityDiagnostics(db, strict) {
  if (!strict) return [];
  const symbolUnresolvedThreshold = 0.05;
  const dbUnknownThreshold = 0.25;
  const outboundUnownedThreshold = 0.01;
  const symbol = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) resolved, SUM(CASE WHEN status='unresolved' THEN 1 ELSE 0 END) unresolved FROM symbol_calls").get();
  const top = db.prepare("SELECT callee_expression calleeExpression,COUNT(*) count FROM symbol_calls WHERE status='unresolved' GROUP BY callee_expression ORDER BY count DESC,callee_expression LIMIT 5").all();
  const evidence = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN json_valid(evidence_json)=0 OR json_type(evidence_json) <> 'object' THEN 1 ELSE 0 END) nonObject FROM symbol_calls").get();
  const dbq = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN query_entity IS NOT NULL THEN 1 ELSE 0 END) known, SUM(CASE WHEN query_entity IS NULL THEN 1 ELSE 0 END) unknown FROM outbound_calls WHERE call_type='local_db_query'").get();
  const outbound = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN source_symbol_id IS NULL THEN 1 ELSE 0 END) withoutOwnership FROM outbound_calls").get();
  const outboundEvidence = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN evidence_json IS NULL THEN 1 ELSE 0 END) missing, SUM(CASE WHEN evidence_json IS NOT NULL AND json_valid(evidence_json)=0 THEN 1 ELSE 0 END) invalid, SUM(CASE WHEN evidence_json IS NOT NULL AND json_valid(evidence_json)=1 AND json_type(evidence_json) <> 'object' THEN 1 ELSE 0 END) nonObject FROM outbound_calls").get();
  const outboundEvidenceExamples = db.prepare("SELECT call_type callType, source_file sourceFile, source_line sourceLine FROM outbound_calls WHERE evidence_json IS NULL OR json_valid(evidence_json)=0 OR json_type(evidence_json) <> 'object' ORDER BY source_file, source_line LIMIT 10").all();
  const graphEvidence = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN e.evidence_json IS NULL OR json_valid(e.evidence_json)=0 OR json_type(e.evidence_json) <> 'object' THEN 1 ELSE 0 END) nonObject, SUM(CASE WHEN e.evidence_json IS NOT NULL AND json_valid(e.evidence_json)=1 AND json_extract(e.evidence_json,'$.outboundEvidence.parser') IS NOT NULL THEN 1 ELSE 0 END) withOutboundEvidence FROM graph_edges e WHERE e.from_kind='call'").get();
  const graphEvidenceExamples = db.prepare("SELECT c.call_type callType,c.source_file sourceFile,c.source_line sourceLine,e.edge_type edgeType FROM graph_edges e JOIN outbound_calls c ON e.from_kind='call' AND c.id=CAST(e.from_id AS INTEGER) WHERE e.evidence_json IS NULL OR json_valid(e.evidence_json)=0 OR json_type(e.evidence_json) <> 'object' OR json_extract(e.evidence_json,'$.outboundEvidence.parser') IS NULL ORDER BY c.source_file,c.source_line LIMIT 10").all();
  const eventReceiver = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN call_type IN ('async_emit','async_subscribe') THEN 1 ELSE 0 END) eventTotal, SUM(CASE WHEN call_type IN ('async_emit','async_subscribe') AND (json_extract(evidence_json,'$.receiverClassification') IS NULL OR json_extract(evidence_json,'$.receiverClassification') <> 'cap_evidence') THEN 1 ELSE 0 END) questionable FROM outbound_calls").get();
  const dynamicTerminal = db.prepare("SELECT COUNT(*) count FROM graph_edges WHERE status='terminal' AND is_dynamic=1").get();
  const ownerlessByType = db.prepare("SELECT call_type callType, COUNT(*) count FROM outbound_calls WHERE source_symbol_id IS NULL GROUP BY call_type ORDER BY count DESC, call_type").all();
  const ownerlessByCategory = db.prepare(`SELECT CASE
    WHEN COALESCE(evidence_json,'') LIKE '%comment_or_non_executable_source%' THEN 'comment_or_non_executable_source'
    WHEN call_type='async_subscribe' AND COALESCE(evidence_json,'') LIKE '%cap_service_event_subscription%' THEN 'top_level_event_registration'
    WHEN call_type='async_subscribe' THEN 'generic_event_listener_ignored_or_unowned'
    WHEN EXISTS (SELECT 1 FROM symbols s WHERE s.repo_id=outbound_calls.repo_id AND s.source_file=outbound_calls.source_file) THEN 'line_range_mismatch'
    WHEN source_line <= 1 THEN 'unsupported_function_shape'
    WHEN source_line > 1 THEN 'unsupported_callback_shape'
    ELSE 'unknown' END category, COUNT(*) count
    FROM outbound_calls WHERE source_symbol_id IS NULL GROUP BY category ORDER BY count DESC, category`).all();
  const ownerlessExamples = db.prepare(`SELECT CASE
    WHEN COALESCE(evidence_json,'') LIKE '%comment_or_non_executable_source%' THEN 'comment_or_non_executable_source'
    WHEN call_type='async_subscribe' AND COALESCE(evidence_json,'') LIKE '%cap_service_event_subscription%' THEN 'top_level_event_registration'
    WHEN call_type='async_subscribe' THEN 'generic_event_listener_ignored_or_unowned'
    WHEN EXISTS (SELECT 1 FROM symbols s WHERE s.repo_id=outbound_calls.repo_id AND s.source_file=outbound_calls.source_file) THEN 'line_range_mismatch'
    WHEN source_line <= 1 THEN 'unsupported_function_shape'
    WHEN source_line > 1 THEN 'unsupported_callback_shape'
    ELSE 'unknown' END category, call_type callType, source_file sourceFile, source_line sourceLine, unresolved_reason unresolvedReason
    FROM outbound_calls WHERE source_symbol_id IS NULL ORDER BY category, source_file, source_line LIMIT 10`).all();
  const symbolTotal = Number(symbol.total ?? 0);
  const symbolUnresolved = Number(symbol.unresolved ?? 0);
  const symbolUnresolvedRatio = symbolTotal === 0 ? 0 : Number((symbolUnresolved / symbolTotal).toFixed(4));
  const queryTotal = Number(dbq.total ?? 0);
  const queryUnknown = Number(dbq.unknown ?? 0);
  const queryUnknownRatio = queryTotal === 0 ? 0 : Number((queryUnknown / queryTotal).toFixed(4));
  const outboundTotal = Number(outbound.total ?? 0);
  const outboundWithoutOwnership = Number(outbound.withoutOwnership ?? 0);
  const outboundWithoutOwnershipRatio = outboundTotal === 0 ? 0 : Number((outboundWithoutOwnership / outboundTotal).toFixed(4));
  const remoteQuery = remoteQueryTargetQuality(db);
  const invocation = odataInvocationResolutionQuality(db);
  const remoteAction = remoteActionTargetQuality(db);
  const externalHttp = externalHttpTargetQuality(db);
  const aliasQuality = identityAliasBindingQuality(db);
  const noBindingQuality = remoteActionNoBindingQuality(db);
  const contextualQuality = contextualImplementationQuality(db);
  const classInstanceQuality = classInstanceNoiseQuality(db);
  const bindingPropagationQuality = contextualBindingPropagationQuality(db);
  const wrapperQuality = wrapperPathPropagationQuality(db);
  const nestedThisQuality = nestedThisReceiverQuality(db);
  return [
    aliasQuality,
    noBindingQuality,
    contextualQuality,
    classInstanceQuality,
    bindingPropagationQuality,
    wrapperQuality,
    nestedThisQuality,
    remoteQuery,
    invocation,
    remoteAction,
    externalHttp,
    { severity: Number(evidence.nonObject ?? 0) > 0 ? "warning" : "info", code: "strict_symbol_call_evidence_quality", message: "Symbol-call evidence JSON object aggregate", total: Number(evidence.total ?? 0), nonObject: Number(evidence.nonObject ?? 0) },
    { severity: Number(outboundEvidence.missing ?? 0) + Number(outboundEvidence.invalid ?? 0) + Number(outboundEvidence.nonObject ?? 0) > 0 ? "warning" : "info", code: "strict_outbound_evidence_quality", message: "Outbound parser evidence JSON object aggregate", total: Number(outboundEvidence.total ?? 0), missing: Number(outboundEvidence.missing ?? 0), invalid: Number(outboundEvidence.invalid ?? 0), nonObject: Number(outboundEvidence.nonObject ?? 0), examples: outboundEvidenceExamples },
    { severity: Number(graphEvidence.nonObject ?? 0) > 0 || Number(graphEvidence.withOutboundEvidence ?? 0) < Number(graphEvidence.total ?? 0) ? "warning" : "info", code: "strict_graph_evidence_quality", message: "Call-derived graph evidence and parser-evidence propagation aggregate", total: Number(graphEvidence.total ?? 0), nonObject: Number(graphEvidence.nonObject ?? 0), withOutboundEvidence: Number(graphEvidence.withOutboundEvidence ?? 0), examples: graphEvidenceExamples },
    { severity: Number(eventReceiver.questionable ?? 0) > 0 ? "warning" : "info", code: "strict_event_receiver_classification_quality", message: "CAP event receiver classification aggregate", eventTotal: Number(eventReceiver.eventTotal ?? 0), questionable: Number(eventReceiver.questionable ?? 0) },
    { severity: Number(dynamicTerminal.count ?? 0) > 0 ? "warning" : "info", code: "strict_graph_dynamic_flag_consistency", message: "Graph dynamic flag consistency aggregate", dynamicTerminalEdges: Number(dynamicTerminal.count ?? 0) },
    { severity: symbolUnresolvedRatio > symbolUnresolvedThreshold ? "warning" : "info", code: "strict_symbol_call_quality", message: "Symbol-call quality aggregate", total: symbolTotal, resolved: Number(symbol.resolved ?? 0), unresolved: symbolUnresolved, unresolvedRatio: symbolUnresolvedRatio, unresolvedRatioThreshold: symbolUnresolvedThreshold, topUnresolvedCallees: top },
    { severity: queryUnknownRatio > dbUnknownThreshold ? "warning" : "info", code: "strict_db_query_quality", message: "Local DB query quality aggregate", total: queryTotal, known: Number(dbq.known ?? 0), unknown: queryUnknown, unknownRatio: queryUnknownRatio, unknownRatioThreshold: dbUnknownThreshold },
    { severity: outboundWithoutOwnershipRatio > outboundUnownedThreshold ? "warning" : "info", code: "strict_outbound_source_ownership_quality", message: "Outbound call source-symbol ownership aggregate", total: outboundTotal, withoutOwnership: outboundWithoutOwnership, withoutOwnershipRatio: outboundWithoutOwnershipRatio, withoutOwnershipRatioThreshold: outboundUnownedThreshold, ownerlessByType, ownerlessByCategory, ownerlessExamples }
  ];
}
function identityAliasBindingQuality(db) {
  const examples = db.prepare(`SELECT c.source_file sourceFile,c.source_line sourceLine,c.service_binding_id serviceBindingId,json_extract(c.evidence_json,'$.receiver') receiverName,b.variable_name aliasSourceVariable,'same-file identifier alias still lacks a binding id' parserReason
    FROM outbound_calls c JOIN service_bindings b ON b.repo_id=c.repo_id AND b.source_file=c.source_file
    WHERE c.call_type='remote_action' AND c.service_binding_id IS NULL AND json_extract(c.evidence_json,'$.receiver') IS NOT NULL
      AND c.evidence_json LIKE '%' || '"aliasOf":"' || json_extract(c.evidence_json,'$.receiver') || '"' || '%'
    ORDER BY c.source_file,c.source_line LIMIT 5`).all();
  return { severity: examples.length > 0 ? "warning" : "info", code: "strict_identity_alias_binding_quality", message: "Remote sends that look like missed same-file identity aliases", missedAliasBindingCalls: examples.length, examples };
}
function remoteActionNoBindingQuality(db) {
  const categoryCase = `CASE
    WHEN c.unresolved_reason='dynamic_operation_path_identifier' THEN 'dynamic_path_identifier'
    WHEN json_extract(c.evidence_json,'$.classifier')='higher_order_wrapper_literal_path' OR json_extract(c.evidence_json,'$.operationPathExpression') IS NOT NULL THEN 'likely_higher_order_wrapper_path_needed'
    WHEN json_extract(c.evidence_json,'$.receiver') LIKE '%.%' THEN 'likely_parameter_context_needed'
    WHEN EXISTS (
      SELECT 1 FROM symbol_calls sc
      JOIN symbols caller ON caller.id=sc.caller_symbol_id
      JOIN symbols callee ON callee.id=sc.callee_symbol_id
      WHERE sc.status='resolved'
        AND sc.source_file=c.source_file
        AND caller.id=c.source_symbol_id
        AND json_extract(sc.evidence_json,'$.relation')='class_instance_method'
        AND (callee.evidence_json IS NULL OR json_extract(callee.evidence_json,'$.parameterBindings') IS NULL)
    ) THEN 'likely_instance_method_parameter_metadata_needed'
    WHEN EXISTS (SELECT 1 FROM service_bindings b WHERE b.repo_id=c.repo_id AND b.source_file=c.source_file AND ABS(b.source_line-c.source_line) < 50) THEN 'likely_missing_assignment_binding'
    WHEN e.status='unresolved' AND COALESCE(e.unresolved_reason,'') LIKE '%No indexed target operation%' THEN 'no_indexed_target_operation'
    WHEN c.operation_path_expr IS NOT NULL AND (c.operation_path_expr LIKE '/%' OR c.operation_path_expr NOT LIKE '%/%') THEN 'operation_path_only_no_static_service_signal'
    ELSE 'external_or_entity_path_not_action' END`;
  const rows = db.prepare(`SELECT ${categoryCase} category,COALESCE(e.status,'missing_edge') status,COUNT(*) count
    FROM outbound_calls c LEFT JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT)
    WHERE c.call_type='remote_action' AND c.operation_path_expr IS NOT NULL AND c.service_binding_id IS NULL
    GROUP BY category,status ORDER BY count DESC,category,status`).all();
  const examples = db.prepare(`SELECT c.source_file sourceFile,c.source_line sourceLine,json_extract(c.evidence_json,'$.receiver') receiverName,c.operation_path_expr operationPath,COALESCE(e.status,'missing_edge') status,${categoryCase} category
    FROM outbound_calls c LEFT JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT)
    WHERE c.call_type='remote_action' AND c.operation_path_expr IS NOT NULL AND c.service_binding_id IS NULL ORDER BY c.source_file,c.source_line LIMIT 8`).all();
  const total = rows.reduce((sum, row) => sum + Number(row.count ?? 0), 0);
  return { severity: total > 0 ? "warning" : "info", code: "strict_remote_action_no_binding_quality", message: "Remote actions with operation paths but no service binding id", total, breakdown: rows, examples };
}
function classInstanceNoiseQuality(db) {
  const builtIns = ["Set", "Map", "WeakSet", "WeakMap", "Date", "RegExp", "URL", "URLSearchParams", "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "AggregateError", "ArrayBuffer", "SharedArrayBuffer", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "Promise", "AbortController"];
  const placeholders = builtIns.map(() => "?").join(",");
  const aggregate = db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN status='unresolved' THEN 1 ELSE 0 END) unresolved,
      SUM(CASE WHEN status='unresolved' AND json_extract(evidence_json,'$.className') IN (${placeholders}) THEN 1 ELSE 0 END) unresolvedBuiltIn
    FROM symbol_calls WHERE json_extract(evidence_json,'$.relation')='class_instance_method'`).get(...builtIns);
  const byConstructor = db.prepare(`SELECT json_extract(evidence_json,'$.className') constructorName,COUNT(*) unresolvedCount
    FROM symbol_calls WHERE status='unresolved' AND json_extract(evidence_json,'$.relation')='class_instance_method'
    GROUP BY constructorName ORDER BY unresolvedCount DESC,constructorName LIMIT 10`).all();
  return { severity: Number(aggregate.unresolvedBuiltIn ?? 0) > 0 ? "warning" : "info", code: "strict_class_instance_noise_quality", message: "Class-instance symbol-call aggregate with built-in constructor guard", totalClassInstanceCalls: Number(aggregate.total ?? 0), unresolvedClassInstanceCalls: Number(aggregate.unresolved ?? 0), unresolvedBuiltInClassInstanceCalls: Number(aggregate.unresolvedBuiltIn ?? 0), unresolvedByConstructor: byConstructor };
}
function contextualBindingPropagationQuality(db) {
  const serviceClientCalls = db.prepare(`SELECT COUNT(*) count FROM symbol_calls sc
    WHERE json_extract(sc.evidence_json,'$.callArguments[0].kind') IN ('identifier','object_literal')`).get();
  const missingMetadata = db.prepare(`SELECT COUNT(*) count FROM symbol_calls sc JOIN symbols s ON s.id=sc.callee_symbol_id
    WHERE sc.status='resolved' AND json_extract(sc.evidence_json,'$.callArguments[0].kind') IN ('identifier','object_literal')
      AND (s.evidence_json IS NULL OR json_extract(s.evidence_json,'$.parameterBindings') IS NULL)`).get();
  const destructuredUnmapped = db.prepare(`SELECT COUNT(*) count FROM symbol_calls sc JOIN symbols s ON s.id=sc.callee_symbol_id
    WHERE json_extract(sc.evidence_json,'$.callArguments[0].kind')='object_literal'
      AND json_extract(s.evidence_json,'$.parameterBindings[0].kind')='object_pattern'
      AND json_array_length(json_extract(sc.evidence_json,'$.callArguments[0].properties')) > json_array_length(json_extract(s.evidence_json,'$.parameterBindings[0].properties'))`).get();
  const opportunities = db.prepare(`SELECT c.source_file sourceFile,c.source_line sourceLine,json_extract(c.evidence_json,'$.receiver') receiverName,c.operation_path_expr operationPath,b.alias bindingAlias,b.alias_expr bindingAliasExpr,b.service_path_expr servicePathExpr,b.destination_expr destinationExpr,req.service_path requireServicePath,req.destination requireDestination,COALESCE(e.status,'missing_edge') persistedStatus,
      CASE
        WHEN (b.alias_expr LIKE '%$%' OR b.service_path_expr LIKE '%$%' OR b.destination_expr LIKE '%$%') THEN 'runtime_variables_required'
        WHEN b.alias IS NOT NULL AND req.id IS NULL AND b.service_path_expr IS NULL THEN 'alias_without_matching_cds_requires'
        WHEN req.id IS NOT NULL AND COALESCE(e.status,'missing_edge')!='resolved' THEN 'cds_requires_present_but_persisted_resolution_unresolved'
        ELSE 'trace_time_contextual_binding_candidate'
      END contextualStatus
    FROM outbound_calls c
    LEFT JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT)
    LEFT JOIN service_bindings b ON b.id=c.service_binding_id
    LEFT JOIN cds_requires req ON req.repo_id=c.repo_id AND req.alias=b.alias
    WHERE c.call_type='remote_action' AND json_extract(c.evidence_json,'$.receiver') IS NOT NULL
      AND (c.service_binding_id IS NULL OR e.status IS NULL OR e.status!='resolved')
      AND EXISTS (SELECT 1 FROM symbol_calls sc WHERE sc.status='resolved' AND sc.source_file=c.source_file)
    ORDER BY c.source_file,c.source_line LIMIT 8`).all();
  const statusRows = db.prepare(`SELECT contextualStatus,COUNT(*) count FROM (
    SELECT CASE
        WHEN (b.alias_expr LIKE '%$%' OR b.service_path_expr LIKE '%$%' OR b.destination_expr LIKE '%$%') THEN 'runtime_variables_required'
        WHEN b.alias IS NOT NULL AND req.id IS NULL AND b.service_path_expr IS NULL THEN 'alias_without_matching_cds_requires'
        WHEN req.id IS NOT NULL AND COALESCE(e.status,'missing_edge')!='resolved' THEN 'cds_requires_present_but_persisted_resolution_unresolved'
        ELSE 'trace_time_contextual_binding_candidate'
      END contextualStatus
    FROM outbound_calls c
    LEFT JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT)
    LEFT JOIN service_bindings b ON b.id=c.service_binding_id
    LEFT JOIN cds_requires req ON req.repo_id=c.repo_id AND req.alias=b.alias
    WHERE c.call_type='remote_action' AND json_extract(c.evidence_json,'$.receiver') IS NOT NULL
      AND (c.service_binding_id IS NULL OR e.status IS NULL OR e.status!='resolved')
      AND EXISTS (SELECT 1 FROM symbol_calls sc WHERE sc.status='resolved' AND sc.source_file=c.source_file)
  ) GROUP BY contextualStatus ORDER BY count DESC,contextualStatus`).all();
  const resolvedContextual = db.prepare(`SELECT COUNT(*) count FROM outbound_calls c JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT) WHERE c.call_type='remote_action' AND e.status='resolved' AND c.service_binding_id IS NOT NULL`).get();
  const totalOpportunities = statusRows.reduce((sum, row) => sum + Number(row.count ?? 0), 0);
  const actionableStatuses = /* @__PURE__ */ new Set(["alias_without_matching_cds_requires", "cds_requires_present_but_persisted_resolution_unresolved", "trace_time_contextual_binding_candidate"]);
  const actionableOpportunityCount = statusRows.reduce((sum, row) => actionableStatuses.has(String(row.contextualStatus)) ? sum + Number(row.count ?? 0) : sum, 0);
  const severity = Number(missingMetadata.count ?? 0) + Number(destructuredUnmapped.count ?? 0) + actionableOpportunityCount > 0 ? "warning" : "info";
  return { severity, code: "strict_contextual_binding_propagation_quality", message: "Contextual service-client propagation opportunities for trace-time helper resolution", localSymbolCallsWithServiceClientArguments: Number(serviceClientCalls.count ?? 0), calleeSymbolsMissingParameterMetadata: Number(missingMetadata.count ?? 0), destructuredObjectParametersPossiblyUnmapped: Number(destructuredUnmapped.count ?? 0), contextualHelperSendsResolvedDuringPersistedLink: Number(resolvedContextual.count ?? 0), traceTimeContextualOpportunities: totalOpportunities, traceTimeContextualOpportunityBreakdown: statusRows.length > 0 ? statusRows : [{ contextualStatus: "no_contextual_opportunity", count: 0 }], exampleCount: opportunities.length, examples: opportunities };
}
function nestedThisReceiverQuality(db) {
  const aggregate = db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN json_extract(evidence_json,'$.relation')='indexed_this_method' THEN 1 ELSE 0 END) resolvedToCurrentClass,
      SUM(CASE WHEN json_extract(evidence_json,'$.relation')='class_instance_method' THEN 1 ELSE 0 END) withExplicitHelperInstanceEvidence
    FROM symbol_calls WHERE callee_expression LIKE 'this.%.%'`).get();
  const examples = db.prepare(`SELECT source_file sourceFile,source_line sourceLine,callee_expression calleeExpression,json_extract(evidence_json,'$.relation') relation,json_extract(evidence_json,'$.targetName') targetName
    FROM symbol_calls WHERE callee_expression LIKE 'this.%.%' AND json_extract(evidence_json,'$.relation')='indexed_this_method'
    ORDER BY source_file,source_line LIMIT 8`).all();
  return { severity: Number(aggregate.resolvedToCurrentClass ?? 0) > 0 ? "warning" : "info", code: "strict_nested_this_receiver_quality", message: "Nested this receiver symbol-call aggregate", nestedThisReceiverCallsConsidered: Number(aggregate.total ?? 0), nestedThisResolvedToCurrentClass: Number(aggregate.resolvedToCurrentClass ?? 0), nestedThisWithExplicitHelperInstanceEvidence: Number(aggregate.withExplicitHelperInstanceEvidence ?? 0), warningExamples: examples };
}
function contextualImplementationQuality(db) {
  const rows = db.prepare(`SELECT status,COALESCE(unresolved_reason,status) reason,COUNT(*) count
    FROM graph_edges WHERE edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND status IN ('ambiguous','unresolved') GROUP BY status,reason ORDER BY status,count DESC,reason`).all();
  const examples = db.prepare(`SELECT json_extract(evidence_json,'$.servicePath') servicePath,json_extract(evidence_json,'$.operationPath') operationPath,status,unresolved_reason unresolvedReason,
      json_extract(evidence_json,'$.candidates[0].rejectedReasons[0]') topRejectedReason,
      json_extract(evidence_json,'$.candidates[0].acceptedReasons[0]') topAcceptedReason
    FROM graph_edges WHERE edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND status IN ('ambiguous','unresolved') ORDER BY status,id LIMIT 6`).all();
  const total = rows.reduce((sum, row) => sum + Number(row.count ?? 0), 0);
  return { severity: total > 0 ? "warning" : "info", code: "strict_contextual_implementation_quality", message: "Implementation hops stopped by ambiguous or unresolved implementation edges", total, breakdown: rows, examples };
}
function wrapperPathPropagationQuality(db) {
  const examples = db.prepare(`SELECT source_file sourceFile,source_line sourceLine,json_extract(evidence_json,'$.receiver') receiverName,json_extract(evidence_json,'$.operationPathExpression') pathIdentifier,CASE WHEN json_extract(evidence_json,'$.literalCallerArgumentDetected') IS NOT NULL THEN 1 ELSE 0 END literalCallerArgumentDetected
    FROM outbound_calls WHERE call_type='remote_action' AND unresolved_reason='dynamic_operation_path_identifier' ORDER BY source_file,source_line LIMIT 5`).all();
  const aggregate = db.prepare("SELECT COUNT(*) count FROM outbound_calls WHERE call_type='remote_action' AND unresolved_reason='dynamic_operation_path_identifier'").get();
  return { severity: Number(aggregate.count ?? 0) > 0 ? "warning" : "info", code: "strict_wrapper_path_propagation_quality", message: "Dynamic path sends where send({ path }) used a path identifier", dynamicPathIdentifierCalls: Number(aggregate.count ?? 0), examples };
}
function remoteQueryTargetQuality(db) {
  const aggregate = db.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN e.edge_type='HANDLER_RUNS_REMOTE_QUERY' AND e.status='terminal' THEN 1 ELSE 0 END) terminal,
    SUM(CASE WHEN e.edge_type='HANDLER_RUNS_REMOTE_QUERY' AND e.to_id GLOB '[0-9]*' THEN 1 ELSE 0 END) numericTargets,
    SUM(CASE WHEN e.edge_type='UNRESOLVED_EDGE' OR e.status='unresolved' THEN 1 ELSE 0 END) unresolved
    FROM outbound_calls c LEFT JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT) WHERE c.call_type='remote_query'`).get();
  const examples = db.prepare(`SELECT c.source_file sourceFile,c.source_line sourceLine,c.query_entity queryEntity,e.edge_type edgeType,e.status status,e.to_id target
    FROM outbound_calls c LEFT JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT)
    WHERE c.call_type='remote_query' AND (e.id IS NULL OR e.edge_type<>'HANDLER_RUNS_REMOTE_QUERY' OR e.status<>'terminal' OR e.to_id GLOB '[0-9]*')
    ORDER BY c.source_file,c.source_line LIMIT 5`).all();
  const numericTargets = Number(aggregate.numericTargets ?? 0);
  const unresolved = Number(aggregate.unresolved ?? 0);
  return { severity: numericTargets + unresolved > 0 ? "warning" : "info", code: "strict_remote_query_target_quality", message: "Remote query terminal target quality aggregate", totalRemoteQueryCalls: Number(aggregate.total ?? 0), terminalRemoteQueryEdges: Number(aggregate.terminal ?? 0), numericTargetCount: numericTargets, unresolvedRemoteQueryCount: unresolved, examples };
}
function remoteActionTargetQuality(db) {
  const aggregate = db.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN e.status='unresolved' THEN 1 ELSE 0 END) unresolved,
    SUM(CASE WHEN e.status='unresolved' AND e.to_id GLOB '[0-9]*' THEN 1 ELSE 0 END) numericTargets,
    SUM(CASE WHEN e.status='unresolved' AND (e.to_id='Remote action: unknown path' OR e.to_id='Remote action: dynamic path') THEN 1 ELSE 0 END) semanticTargets
    FROM outbound_calls c LEFT JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT) WHERE c.call_type='remote_action'`).get();
  const examples = db.prepare(`SELECT c.source_file sourceFile,c.source_line sourceLine,c.operation_path_expr operationPath,e.status status,e.to_id target
    FROM outbound_calls c LEFT JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT)
    WHERE c.call_type='remote_action' AND e.status='unresolved' AND e.to_id GLOB '[0-9]*' ORDER BY c.source_file,c.source_line LIMIT 5`).all();
  const numericTargets = Number(aggregate.numericTargets ?? 0);
  return { severity: numericTargets > 0 ? "warning" : "info", code: "strict_remote_action_target_quality", message: "Remote action unresolved target quality aggregate", totalRemoteActionCalls: Number(aggregate.total ?? 0), unresolvedRemoteActionCalls: Number(aggregate.unresolved ?? 0), numericUnresolvedTargetCount: numericTargets, semanticUnknownOrDynamicTargetCount: Number(aggregate.semanticTargets ?? 0), examples };
}
function externalHttpTargetQuality(db) {
  const aggregate = db.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN e.to_kind='external_destination' THEN 1 ELSE 0 END) destinationTargets,
    SUM(CASE WHEN e.to_kind='external_endpoint' AND json_extract(e.evidence_json,'$.externalTarget.kind')='static_url' THEN 1 ELSE 0 END) staticEndpointTargets,
    SUM(CASE WHEN e.to_kind='external_endpoint' AND json_extract(e.evidence_json,'$.externalTarget.dynamic')=1 THEN 1 ELSE 0 END) dynamicEndpointTargets,
    SUM(CASE WHEN e.to_kind='external_endpoint' AND json_extract(e.evidence_json,'$.externalTarget.kind')='unknown' THEN 1 ELSE 0 END) unknownEndpointTargets,
    SUM(CASE WHEN e.to_id GLOB '[0-9]*' THEN 1 ELSE 0 END) numericTargets,
    SUM(CASE WHEN e.evidence_json IS NULL OR json_valid(e.evidence_json)=0 OR json_extract(e.evidence_json,'$.externalTarget.kind') IS NULL THEN 1 ELSE 0 END) invalidEvidence
    FROM outbound_calls c LEFT JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT) WHERE c.call_type='external_http'`).get();
  const examples = db.prepare(`SELECT c.source_file sourceFile,c.source_line sourceLine,e.to_kind targetKind,e.to_id targetId,json_extract(e.evidence_json,'$.externalTarget.label') label,json_extract(e.evidence_json,'$.externalTarget.kind') kind
    FROM outbound_calls c LEFT JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT)
    WHERE c.call_type='external_http' AND (e.to_id GLOB '[0-9]*' OR e.evidence_json IS NULL OR json_valid(e.evidence_json)=0 OR json_extract(e.evidence_json,'$.externalTarget.kind') IS NULL)
    ORDER BY c.source_file,c.source_line LIMIT 5`).all();
  const numericTargets = Number(aggregate.numericTargets ?? 0);
  const invalidEvidence = Number(aggregate.invalidEvidence ?? 0);
  return { severity: numericTargets + invalidEvidence > 0 ? "warning" : "info", code: "strict_external_http_target_quality", message: "External HTTP semantic target aggregate", totalExternalHttpCalls: Number(aggregate.total ?? 0), semanticDestinationTargets: Number(aggregate.destinationTargets ?? 0), semanticStaticEndpointTargets: Number(aggregate.staticEndpointTargets ?? 0), dynamicEndpointTargets: Number(aggregate.dynamicEndpointTargets ?? 0), unknownEndpointTargets: Number(aggregate.unknownEndpointTargets ?? 0), numericTargetCount: numericTargets, invalidOrMissingExternalTargetEvidence: invalidEvidence, examples };
}
function odataInvocationResolutionQuality(db) {
  const aggregate = db.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN e.status='resolved' THEN 1 ELSE 0 END) resolved,
    SUM(CASE WHEN e.status='dynamic' THEN 1 ELSE 0 END) dynamic,
    SUM(CASE WHEN e.status='ambiguous' THEN 1 ELSE 0 END) ambiguous,
    SUM(CASE WHEN e.status='unresolved' THEN 1 ELSE 0 END) unresolved
    FROM outbound_calls c JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT)
    WHERE c.call_type='remote_action' AND c.operation_path_expr LIKE '%(%'`).get();
  const rows = db.prepare(`SELECT c.id id,c.operation_path_expr operationPathExpr,c.source_file sourceFile,c.source_line sourceLine,e.status status,e.unresolved_reason unresolvedReason
    FROM outbound_calls c JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT)
    WHERE c.call_type='remote_action' AND e.status IN ('unresolved','ambiguous') AND c.operation_path_expr LIKE '%(%'
    ORDER BY c.source_file,c.source_line LIMIT 100`).all();
  const examples = [];
  let unresolvedMatchingIndexedOperation = 0;
  let ambiguousNormalizedCalls = 0;
  for (const row of rows) {
    const normalized = normalizeODataOperationInvocationPath(row.operationPathExpr);
    if (!normalized?.wasInvocation) continue;
    const normalizedName = normalized.normalizedOperationPath.replace(/^\//, "");
    const simpleName = normalizedName.split(".").at(-1) ?? normalizedName;
    const candidates = db.prepare("SELECT s.service_path servicePath,o.operation_path operationPath,o.operation_name operationName FROM cds_operations o JOIN cds_services s ON s.id=o.service_id WHERE o.operation_path IN (?,?) OR o.operation_name IN (?,?) ORDER BY s.service_path,o.operation_name LIMIT 5").all(normalized.normalizedOperationPath, `/${simpleName}`, normalizedName, simpleName);
    if (candidates.length === 0) continue;
    if (row.status === "ambiguous") ambiguousNormalizedCalls += 1;
    if (row.status === "unresolved") unresolvedMatchingIndexedOperation += 1;
    if (examples.length < 5) examples.push({ sourceFile: row.sourceFile, sourceLine: row.sourceLine, rawOperationPath: row.operationPathExpr, normalizedOperationPath: normalized.normalizedOperationPath, candidateCount: candidates.length, candidates });
  }
  return { severity: unresolvedMatchingIndexedOperation + ambiguousNormalizedCalls > 0 ? "warning" : "info", code: "strict_odata_invocation_resolution_quality", message: "OData invocation-path resolution quality aggregate", totalInvocationRemoteActions: Number(aggregate.total ?? 0), resolvedInvocationCalls: Number(aggregate.resolved ?? 0), dynamicInvocationCalls: Number(aggregate.dynamic ?? 0), ambiguousInvocationCalls: Number(aggregate.ambiguous ?? 0), unresolvedInvocationCalls: Number(aggregate.unresolved ?? 0), ambiguousNormalizedCalls, unresolvedNormalizedCallsWithIndexedCandidates: unresolvedMatchingIndexedOperation, examples };
}
function createProgram() {
  const program = new Command();
  program.name("service-flow").description(
    "Trace SAP CAP service-to-service flows across multi-repository workspaces"
  ).version(VERSION);
  program.command("init").argument("<workspace>").option("--db <path>").option("--ignore <pattern...>").action(
    (workspace, opts) => void init(workspace, opts).catch(fail)
  );
  program.command("index").option("--workspace <path>").option("--repo <name>").option("--force").action(
    (opts) => void withWorkspace(opts.workspace, async (db, workspaceId) => {
      const r = await indexWorkspace(db, workspaceId, {
        repo: opts.repo,
        force: Boolean(opts.force)
      });
      process.stdout.write(
        `Indexed ${r.indexedCount} repositories, skipped ${r.skippedCount}, ${r.fileCount} files, ${r.diagnosticCount} diagnostics
`
      );
    }).catch(fail)
  );
  program.command("link").option("--workspace <path>").option("--force").action(
    (opts) => void withWorkspace(opts.workspace, (db, workspaceId) => {
      const r = linkWorkspace(db, workspaceId);
      const upgradeWarnings = linkUpgradeWarnings(db);
      process.stdout.write(
        `${upgradeWarnings.length ? `Warnings: ${upgradeWarnings.map((item) => String(item.code)).join(", ")}. Run service-flow doctor --strict for remediation.
` : ""}Linked ${r.edgeCount} edges: ${r.remoteResolvedCount} remote operation calls resolved, ${r.localResolvedCount} local operation calls resolved, ${r.unresolvedCount} unresolved operation calls, ${r.ambiguousCount} ambiguous operation calls, ${r.dynamicCount} dynamic operation calls, ${r.terminalCount} terminal call edges, ${r.dependencyResolvedCount} dependency resolved, ${r.dependencyAmbiguousCount} dependency ambiguous, ${r.implementationResolvedCount} implementation resolved, ${r.implementationAmbiguousCount} implementation ambiguous, ${r.implementationUnresolvedCount} implementation unresolved
`
      );
    }).catch(fail)
  );
  program.command("trace").option("--workspace <path>").option("--repo <name>").option("--operation <name>").option("--service <path>").option("--path <operationPath>").option("--handler <name>").option("--depth <n>", "trace depth", "25").option("--format <format>", "table|json|mermaid", "table").option("--include-external").option("--include-db").option("--include-async").option("--var <key=value>", "dynamic variable", collect, []).action(
    (opts) => void withReadOnlyWorkspace(opts.workspace, (db) => {
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
        opts.format === "json" ? renderTraceJson(result) : opts.format === "mermaid" ? renderMermaid(result) : renderTraceTable(result)
      );
    }).catch(fail)
  );
  const list = program.command("list");
  list.command("repos").option("--workspace <path>").action(
    (opts) => void withReadOnlyWorkspace(
      opts.workspace,
      (db) => process.stdout.write(
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
  list.command("services").option("--workspace <path>").option("--repo <name>").action(
    (opts) => void withReadOnlyWorkspace(opts.workspace, (db) => {
      const repo = opts.repo ? repoByName(db, opts.repo) : void 0;
      if (opts.repo && !repo) {
        process.stdout.write(renderJson([{ severity: "warning", code: "selector_repo_not_found", message: `Repository selector not found: ${opts.repo}` }]));
        return;
      }
      const rows = db.prepare(
        "SELECT r.name repo,s.service_path servicePath,s.qualified_name qualifiedName FROM cds_services s JOIN repositories r ON r.id=s.repo_id WHERE (? IS NULL OR s.repo_id=?) ORDER BY r.name,s.service_path"
      ).all(repo?.id, repo?.id);
      process.stdout.write(renderJson(rows));
    }).catch(fail)
  );
  list.command("operations").option("--workspace <path>").option("--repo <name>").option("--service <path>").action(
    (opts) => void withReadOnlyWorkspace(opts.workspace, (db) => {
      const repo = opts.repo ? repoByName(db, opts.repo) : void 0;
      if (opts.repo && !repo) {
        process.stdout.write(renderJson([{ severity: "warning", code: "selector_repo_not_found", message: `Repository selector not found: ${opts.repo}` }]));
        return;
      }
      const rows = db.prepare(
        "SELECT r.name repo,s.service_path servicePath,o.operation_name operation,o.operation_path path FROM cds_operations o JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id WHERE (? IS NULL OR s.repo_id=?) AND (? IS NULL OR s.service_path=?)"
      ).all(repo?.id, repo?.id, opts.service, opts.service);
      process.stdout.write(renderJson(rows));
    }).catch(fail)
  );
  list.command("calls").option("--workspace <path>").option("--repo <name>").option("--operation <name>").action(
    (opts) => void withReadOnlyWorkspace(opts.workspace, (db) => {
      const repo = opts.repo ? repoByName(db, opts.repo) : void 0;
      if (opts.repo && !repo) {
        process.stdout.write(renderJson([{ severity: "warning", code: "selector_repo_not_found", message: `Repository selector not found: ${opts.repo}` }]));
        return;
      }
      const rows = db.prepare(
        "SELECT r.name repo,c.call_type type,c.operation_path_expr path,c.source_file file,c.source_line line FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id WHERE (? IS NULL OR c.repo_id=?) AND (? IS NULL OR c.operation_path_expr=? OR c.operation_path_expr=? OR c.payload_summary LIKE ?)"
      ).all(
        repo?.id,
        repo?.id,
        opts.operation,
        opts.operation,
        opts.operation ? `/${opts.operation}` : void 0,
        opts.operation ? `%${opts.operation}%` : void 0
      );
      process.stdout.write(renderJson(rows));
    }).catch(fail)
  );
  program.command("graph").option("--workspace <path>").option("--repo <name>").option("--operation <name>").option("--service <path>").option("--path <operationPath>").option("--format <format>", "mermaid|json", "mermaid").option("--var <key=value>", "dynamic variable", collect, []).action(
    (opts) => void withReadOnlyWorkspace(opts.workspace, (db) => {
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
          includeExternal: true,
          vars: parseVars(opts.var)
        }
      );
      process.stdout.write(
        opts.format === "json" ? renderTraceJson(result) : renderMermaid(result)
      );
    }).catch(fail)
  );
  const inspect = program.command("inspect");
  inspect.command("repo").argument("<name>").option("--workspace <path>").action(
    (name, opts) => void withReadOnlyWorkspace(
      opts.workspace,
      (db) => process.stdout.write(
        renderJson(repoByName(db, name) ?? { error: "repo not found" })
      )
    ).catch(fail)
  );
  inspect.command("operation").argument("<selector>").option("--workspace <path>").action(
    (selector, opts) => void withReadOnlyWorkspace(opts.workspace, (db) => {
      const rows = db.prepare(
        "SELECT * FROM cds_operations WHERE operation_name=? OR operation_path=?"
      ).all(selector, selector);
      process.stdout.write(renderJson(rows));
    }).catch(fail)
  );
  program.command("doctor").option("--workspace <path>").option("--strict").action(
    (opts) => void withReadOnlyWorkspace(opts.workspace, (db) => {
      const diagnostics = db.prepare(
        "SELECT severity,code,message,source_file sourceFile,source_line sourceLine FROM diagnostics ORDER BY id"
      ).all();
      const health = db.prepare(
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
               FROM index_runs WHERE status='running' AND datetime(started_at) < datetime('now','-60 minutes')`
      ).all(Boolean(opts.strict), Boolean(opts.strict), Boolean(opts.strict), Boolean(opts.strict), Boolean(opts.strict), Boolean(opts.strict), Boolean(opts.strict), Boolean(opts.strict));
      const localServiceHealth = localServiceDiagnostics(db, Boolean(opts.strict));
      const parserQualityHealth = parserQualityDiagnostics(db, Boolean(opts.strict));
      const schemaDriftHealth = schemaDriftDiagnostics(db, Boolean(opts.strict));
      const allDiagnostics = [...diagnostics, ...health, ...localServiceHealth, ...schemaDriftHealth, ...parserQualityHealth];
      process.stdout.write(
        allDiagnostics.length ? renderJson(allDiagnostics) : `${pc.green("No diagnostics recorded")}
`
      );
    }).catch(fail)
  );
  program.command("clean").option("--workspace <path>").option("--db-only").action(
    (opts) => void (async () => {
      const config = await loadWorkspaceConfig(opts.workspace);
      const dbDir = path6.resolve(path6.dirname(config.dbPath));
      const workspaceRoot = path6.resolve(config.rootPath);
      await fs6.rm(config.dbPath, { force: true });
      if (!opts.dbOnly) {
        const marker = path6.join(dbDir, ".service-flow-state");
        const dangerous = /* @__PURE__ */ new Set([
          path6.parse(dbDir).root,
          "/tmp",
          process.env.HOME ? path6.resolve(process.env.HOME) : "",
          workspaceRoot
        ]);
        let ownsState;
        try {
          ownsState = (await fs6.stat(marker)).isFile();
        } catch {
          ownsState = false;
        }
        if (!ownsState || dangerous.has(dbDir))
          throw new Error(
            `Refusing to recursively delete unowned or dangerous state directory: ${dbDir}. Use --db-only to remove only the database file.`
          );
        await fs6.rm(dbDir, { recursive: true, force: true });
      }
      process.stdout.write("Cleaned service-flow state\n");
    })().catch(fail)
  );
  return program;
}
function collect(value, previous) {
  previous.push(value);
  return previous;
}
function fail(error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}
`
  );
  process.exitCode = 1;
}
createProgram().parse(process.argv);
export {
  createProgram
};
//# sourceMappingURL=cli.js.map