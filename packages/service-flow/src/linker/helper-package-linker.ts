import type { Db } from '../db/connection.js';

interface RepoDependencyRow {
  id: number;
  name: string;
  package_name: string | null;
  dependencies_json: string;
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/^@[^/]+\//, '').replace(/[^a-z0-9]+/g, '');
}

function candidatesForDependency(repos: RepoDependencyRow[], dep: string, sourceId: number): RepoDependencyRow[] {
  const exact = repos.filter((repo) => repo.id !== sourceId && repo.package_name === dep);
  if (exact.length > 0) return exact;
  const normalized = normalizeName(dep);
  return repos.filter((repo) => repo.id !== sourceId && normalizeName(repo.name) === normalized);
}

export function linkHelperPackages(db: Db, workspaceId: number): number {
  const repos = db
    .prepare(
      'SELECT id,name,package_name,dependencies_json FROM repositories WHERE workspace_id=?',
    )
    .all(workspaceId) as unknown as RepoDependencyRow[];
  let count = 0;
  for (const repo of repos) {
    const deps = JSON.parse(repo.dependencies_json) as Record<string, string>;
    for (const dep of Object.keys(deps)) {
      const candidates = candidatesForDependency(repos, dep, repo.id);
      if (candidates.length === 0) continue;
      const status = candidates.length === 1 ? 'resolved' : 'ambiguous';
      const helper = candidates.length === 1 ? candidates[0] : undefined;
      db.prepare(
        'INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,unresolved_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        workspaceId,
        'REPO_IMPORTS_HELPER_PACKAGE',
        status,
        'repo',
        String(repo.id),
        helper ? 'repo' : 'repo_candidates',
        helper ? String(helper.id) : candidates.map((candidate) => candidate.id).join(','),
        helper ? 1 : 0.5,
        JSON.stringify({
          dependency: dep,
          candidates: candidates.map((candidate) => ({ id: candidate.id, name: candidate.name, packageName: candidate.package_name })),
          match: helper?.package_name === dep ? 'package_name' : 'normalized_directory',
        }),
        0,
        helper ? null : 'Ambiguous dependency package candidates',
      );
      count += 1;
    }
  }
  return count;
}
