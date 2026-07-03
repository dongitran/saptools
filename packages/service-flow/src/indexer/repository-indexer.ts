import fs from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/connection.js';
import { clearRepoFacts, insertBindings, insertCalls, insertHandler, insertRegistrations, insertRequires, insertService, type RepoRow } from '../db/repositories.js';
import { classifyRepository } from '../discovery/classify-repository.js';
import { parseCdsFile } from '../parsers/cds-parser.js';
import { parseDecorators } from '../parsers/decorator-parser.js';
import { parseHandlerRegistrations } from '../parsers/handler-registration-parser.js';
import { parseOutboundCalls } from '../parsers/outbound-call-parser.js';
import { parsePackageJson } from '../parsers/package-json-parser.js';
import { parseServiceBindings } from '../parsers/service-binding-parser.js';
import { recordFile } from './incremental-index.js';
import { errorMessage } from '../utils/diagnostics.js';
export interface IndexRepoResult { fileCount: number; diagnosticCount: number; }
export async function indexRepository(db: Db, repo: RepoRow, force: boolean): Promise<IndexRepoResult> { void force; let diagnostics = 0; let files = 0; const facts = await parsePackageJson(repo.absolute_path); const kind = await classifyRepository(repo.absolute_path, facts); db.prepare('UPDATE repositories SET package_name=?, package_version=?, dependencies_json=?, kind=?, index_status=? WHERE id=?').run(facts.packageName, facts.packageVersion, JSON.stringify(facts.dependencies), kind, 'indexing', repo.id); clearRepoFacts(db, repo.id); insertRequires(db, repo.id, facts.cdsRequires); const sourceFiles = await findSourceFiles(repo.absolute_path); for (const file of sourceFiles) { try { await recordFile(db, repo.id, repo.absolute_path, file); files += 1; if (file.endsWith('.cds')) for (const s of await parseCdsFile(repo.absolute_path, file)) insertService(db, repo.id, s); if (/\.[jt]s$/.test(file)) { for (const h of await parseDecorators(repo.absolute_path, file)) insertHandler(db, repo.id, h); insertRegistrations(db, repo.id, await parseHandlerRegistrations(repo.absolute_path, file)); insertBindings(db, repo.id, await parseServiceBindings(repo.absolute_path, file)); insertCalls(db, repo.id, await parseOutboundCalls(repo.absolute_path, file)); } } catch (error) { diagnostics += 1; db.prepare('INSERT INTO diagnostics(repo_id,severity,code,message,source_file) VALUES(?,?,?,?,?)').run(repo.id, 'warning', 'parse_failed', errorMessage(error), file); } }
 db.prepare('UPDATE repositories SET last_indexed_at=?, index_status=?, error_count=? WHERE id=?').run(new Date().toISOString(), diagnostics ? 'partial' : 'indexed', diagnostics, repo.id); return { fileCount: files, diagnosticCount: diagnostics }; }

async function findSourceFiles(root: string): Promise<string[]> { const out: string[] = []; async function walk(dir: string, prefix = ''): Promise<void> { const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []); for (const e of entries) { const rel = prefix ? `${prefix}/${e.name}` : e.name; if (e.isDirectory()) { if (!['node_modules','dist','gen','coverage','.git'].includes(e.name)) await walk(path.join(dir, e.name), rel); } else if (/\.(cds|ts|js)$/.test(e.name)) out.push(rel); } } await walk(root); return out.sort(); }
