import fs from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/connection.js';
import {
  clearRepoFacts,
  insertBindings,
  insertCalls,
  insertExecutableSymbols,
  insertHandler,
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
import { parseOutboundCalls } from '../parsers/outbound-call-parser.js';
import { parseExecutableSymbols } from '../parsers/symbol-parser.js';
import { parsePackageJson } from '../parsers/package-json-parser.js';
import { parseServiceBindings } from '../parsers/service-binding-parser.js';
import { sha256File } from '../utils/hashing.js';
import { normalizePath } from '../utils/path-utils.js';
import { errorMessage } from '../utils/diagnostics.js';
import { sha256Text } from '../utils/hashing.js';
import { ANALYZER_VERSION } from '../version.js';
import type { CdsServiceFact, HandlerClassFact, HandlerRegistrationFact, OutboundCallFact, ServiceBindingFact, ExecutableSymbolFact, SymbolCallFact } from '../types.js';
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
  fileRecords: Array<{ relativePath: string; extension: string; sha256: string; sizeBytes: number }>;
}
export async function indexRepository(
  db: Db,
  repo: RepoRow,
  force: boolean,
): Promise<IndexRepoResult> {
  try {
    const sourceFiles = await findSourceFiles(repo.absolute_path);
    const packageFacts = await parsePackageJson(repo.absolute_path);
    const fingerprint = await repositoryFingerprint(repo.absolute_path, sourceFiles, packageFacts);
    if (!force && repo.fingerprint === fingerprint) return { fileCount: 0, diagnosticCount: 0, skipped: true };
    const kind = await classifyRepository(repo.absolute_path, packageFacts);
    const parsed = await parseAllSourceFacts(repo.absolute_path, sourceFiles);
    db.transaction(() => {
      db.prepare('UPDATE repositories SET package_name=?, package_version=?, dependencies_json=?, kind=?, index_status=? WHERE id=?').run(packageFacts.packageName, packageFacts.packageVersion, JSON.stringify(packageFacts.dependencies), kind, 'indexing', repo.id);
      clearRepoFacts(db, repo.id);
      insertRequires(db, repo.id, packageFacts.cdsRequires);
      const fileStmt = db.prepare('INSERT INTO files(repo_id,relative_path,extension,sha256,size_bytes,last_indexed_at) VALUES(?,?,?,?,?,?) ON CONFLICT(repo_id,relative_path) DO UPDATE SET sha256=excluded.sha256,size_bytes=excluded.size_bytes,last_indexed_at=excluded.last_indexed_at');
      for (const file of parsed.fileRecords) fileStmt.run(repo.id, file.relativePath, file.extension, file.sha256, file.sizeBytes, new Date().toISOString());
      for (const s of parsed.services) insertService(db, repo.id, s);
      for (const h of parsed.handlers) insertHandler(db, repo.id, h);
      insertExecutableSymbols(db, repo.id, parsed.symbols);
      insertSymbolCalls(db, repo.id, parsed.symbolCalls);
      insertRegistrations(db, repo.id, parsed.registrations);
      insertBindings(db, repo.id, parsed.bindings);
      insertCalls(db, repo.id, parsed.calls);
      db.prepare("UPDATE repositories SET last_indexed_at=?, index_status='indexed', error_count=0, fingerprint=?, fact_generation=COALESCE(fact_generation,0)+1, graph_stale_reason='facts_changed', graph_stale_at=? WHERE id=?").run(new Date().toISOString(), fingerprint, new Date().toISOString(), repo.id);
    });
    return { fileCount: sourceFiles.length, diagnosticCount: 0, skipped: false };
  } catch (error) {
    const message = errorMessage(error);
    db.prepare("UPDATE repositories SET index_status='failed', error_count=1 WHERE id=?").run(repo.id);
    db.prepare("DELETE FROM diagnostics WHERE repo_id=? AND code IN ('index_failed_snapshot_preserved','source_read_failed')").run(repo.id);
    db.prepare('INSERT INTO diagnostics(repo_id,severity,code,message) VALUES(?,?,?,?)').run(repo.id, 'error', 'source_read_failed', `Index failed before publication; previous facts and fingerprint were preserved. ${message}`);
    return { fileCount: 0, diagnosticCount: 1, skipped: false };
  }
}
async function parseAllSourceFacts(root: string, files: string[]): Promise<ParsedFacts> {
  const facts: ParsedFacts = { services: [], handlers: [], registrations: [], bindings: [], calls: [], symbols: [], symbolCalls: [], fileRecords: [] };
  for (const file of files) {
    const abs = path.join(root, file);
    const stat = await fs.stat(abs);
    facts.fileRecords.push({ relativePath: normalizePath(file), extension: path.extname(file), sha256: await sha256File(abs), sizeBytes: stat.size });
    if (file.endsWith('.cds')) facts.services.push(...(await parseCdsFile(root, file)));
    if (/\.[jt]s$/.test(file)) {
      facts.handlers.push(...(await parseDecorators(root, file)));
      facts.registrations.push(...(await parseHandlerRegistrations(root, file)));
      facts.bindings.push(...(await parseServiceBindings(root, file)));
      const symbolFacts = await parseExecutableSymbols(root, file);
      facts.symbols.push(...symbolFacts.symbols);
      facts.symbolCalls.push(...symbolFacts.calls);
      facts.calls.push(...(await parseOutboundCalls(root, file)));
    }
  }
  return facts;
}
async function findSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix = ''): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!['node_modules', 'dist', 'gen', 'coverage', '.git'].includes(e.name)) await walk(path.join(dir, e.name), rel);
      } else if (/\.(cds|ts|js)$/.test(e.name) && !isDefaultTestFile(rel)) out.push(rel);
    }
  }
  await walk(root);
  return out.sort();
}
function isDefaultTestFile(relativeFile: string): boolean {
  const parts = relativeFile.split('/');
  if (parts.some((part) => ['test', 'tests', '__tests__'].includes(part))) return true;
  return /\.(test|spec)\.[jt]s$/.test(parts.at(-1) ?? '');
}
async function repositoryFingerprint(root: string, files: string[], facts: Awaited<ReturnType<typeof parsePackageJson>>): Promise<string> {
  const packageJson = await fs.readFile(path.join(root, 'package.json'), 'utf8').catch(() => '');
  const normalizedFacts = {
    analyzerVersion: ANALYZER_VERSION,
    packageName: facts.packageName,
    packageVersion: facts.packageVersion,
    dependencies: Object.fromEntries(Object.entries(facts.dependencies).sort()),
    cdsRequires: [...facts.cdsRequires].sort((a, b) => a.alias.localeCompare(b.alias)),
    scripts: Object.fromEntries(Object.entries(facts.scripts).sort()),
    includeTests: false,
    packageJsonHash: sha256Text(packageJson),
  };
  const entries: string[] = [`facts:${JSON.stringify(normalizedFacts)}`];
  for (const file of files) {
    const content = await fs.readFile(path.join(root, file), 'utf8');
    entries.push(`${file}:${sha256Text(content)}`);
  }
  return sha256Text(entries.join('\n'));
}
