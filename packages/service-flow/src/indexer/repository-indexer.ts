import fs from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/connection.js';
import {
  clearRepoFacts,
  insertBindings,
  insertCalls,
  insertHandler,
  insertRegistrations,
  insertRequires,
  insertService,
  type RepoRow
} from '../db/repositories.js';
import { classifyRepository } from '../discovery/classify-repository.js';
import { parseCdsFile } from '../parsers/cds-parser.js';
import { parseDecorators } from '../parsers/decorator-parser.js';
import { parseHandlerRegistrations } from '../parsers/handler-registration-parser.js';
import { parseOutboundCalls } from '../parsers/outbound-call-parser.js';
import { parsePackageJson } from '../parsers/package-json-parser.js';
import { parseServiceBindings } from '../parsers/service-binding-parser.js';
import { recordFile } from './incremental-index.js';
import { errorMessage } from '../utils/diagnostics.js';
import { sha256Text } from '../utils/hashing.js';
import { ANALYZER_VERSION } from '../version.js';
export interface IndexRepoResult {
  fileCount: number;
  diagnosticCount: number;
  skipped: boolean;
}
export async function indexRepository(
  db: Db,
  repo: RepoRow,
  force: boolean
): Promise<IndexRepoResult> {
  let diagnostics = 0;
  let files = 0;
  const sourceFiles = await findSourceFiles(repo.absolute_path);
  const facts = await parsePackageJson(repo.absolute_path);
  const fingerprint = await repositoryFingerprint(repo.absolute_path, sourceFiles, facts, Boolean(force));
  if (!force && repo.fingerprint === fingerprint) return { fileCount: 0, diagnosticCount: 0, skipped: true };
  const kind = await classifyRepository(repo.absolute_path, facts);
  db.prepare(
    'UPDATE repositories SET package_name=?, package_version=?, dependencies_json=?, kind=?, index_status=? WHERE id=?'
  ).run(
    facts.packageName,
    facts.packageVersion,
    JSON.stringify(facts.dependencies),
    kind,
    'indexing',
    repo.id
  );
  clearRepoFacts(db, repo.id);
  insertRequires(db, repo.id, facts.cdsRequires);
  for (const file of sourceFiles) {
    try {
      await recordFile(db, repo.id, repo.absolute_path, file);
      files += 1;
      if (file.endsWith('.cds'))
        for (const s of await parseCdsFile(repo.absolute_path, file))
          insertService(db, repo.id, s);
      if (/\.[jt]s$/.test(file)) {
        for (const h of await parseDecorators(repo.absolute_path, file))
          insertHandler(db, repo.id, h);
        insertRegistrations(
          db,
          repo.id,
          await parseHandlerRegistrations(repo.absolute_path, file)
        );
        insertBindings(
          db,
          repo.id,
          await parseServiceBindings(repo.absolute_path, file)
        );
        insertCalls(
          db,
          repo.id,
          await parseOutboundCalls(repo.absolute_path, file)
        );
      }
    } catch (error) {
      diagnostics += 1;
      db.prepare(
        'INSERT INTO diagnostics(repo_id,severity,code,message,source_file) VALUES(?,?,?,?,?)'
      ).run(repo.id, 'warning', 'parse_failed', errorMessage(error), file);
    }
  }
  db.prepare(
    'UPDATE repositories SET last_indexed_at=?, index_status=?, error_count=?, fingerprint=? WHERE id=?'
  ).run(
    new Date().toISOString(),
    diagnostics ? 'partial' : 'indexed',
    diagnostics,
    fingerprint,
    repo.id
  );
  return { fileCount: files, diagnosticCount: diagnostics, skipped: false };
}

async function findSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix = ''): Promise<void> {
    const entries = await fs
      .readdir(dir, { withFileTypes: true })
      .catch(() => []);
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (
          !['node_modules', 'dist', 'gen', 'coverage', '.git'].includes(e.name)
        )
          await walk(path.join(dir, e.name), rel);
      } else if (/\.(cds|ts|js)$/.test(e.name) && !isDefaultTestFile(rel))
        out.push(rel);
    }
  }
  await walk(root);
  return out.sort();
}

function isDefaultTestFile(relativeFile: string): boolean {
  const parts = relativeFile.split('/');
  if (parts.some((part) => ['test', 'tests', '__tests__'].includes(part)))
    return true;
  return /\.(test|spec)\.[jt]s$/.test(parts.at(-1) ?? '');
}

async function repositoryFingerprint(root: string, files: string[], facts: Awaited<ReturnType<typeof parsePackageJson>>, force: boolean): Promise<string> {
  void force;
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
    const content = await fs.readFile(path.join(root, file), 'utf8').catch(() => '');
    entries.push(`${file}:${sha256Text(content)}`);
  }
  return sha256Text(entries.join('\n'));
}
