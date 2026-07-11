import type { Db } from '../db/connection.js';
import { projectBounded } from '../utils/000-bounded-projection.js';

interface RepoDependencyRow {
  id: number;
  name: string;
  package_name: string | null;
  dependencies_json: string;
}
export interface DependencyLinkSummary {
  edgeCount: number;
  resolvedCount: number;
  ambiguousCount: number;
}
interface CandidateResult {
  candidates: RepoDependencyRow[];
  strategy: 'exact_package_name' | 'normalized_directory';
}
function normalizeName(value: string): string {
  return value.toLowerCase().replace(/^@[^/]+\//, '').replace(/[^a-z0-9]+/g, '');
}
function candidatesForDependency(repos: RepoDependencyRow[], dep: string, sourceId: number): CandidateResult {
  const exact = repos.filter((repo) => repo.id !== sourceId && repo.package_name === dep);
  if (exact.length > 0) return { candidates: exact, strategy: 'exact_package_name' };
  const normalized = normalizeName(dep);
  return { candidates: repos.filter((repo) => repo.id !== sourceId && normalizeName(repo.name) === normalized), strategy: 'normalized_directory' };
}
export function linkHelperPackages(db: Db, workspaceId: number, generation: number): DependencyLinkSummary {
  const repos = db.prepare('SELECT id,name,package_name,dependencies_json FROM repositories WHERE workspace_id=?').all(workspaceId) as unknown as RepoDependencyRow[];
  const summary: DependencyLinkSummary = { edgeCount: 0, resolvedCount: 0, ambiguousCount: 0 };
  for (const repo of repos) {
    const deps = JSON.parse(repo.dependencies_json) as Record<string, string>;
    for (const dep of Object.keys(deps)) {
      const result = candidatesForDependency(repos, dep, repo.id);
      if (result.candidates.length === 0) continue;
      const status = result.candidates.length === 1 ? 'resolved' : 'ambiguous';
      const helper = status === 'resolved' ? result.candidates[0] : undefined;
      const projection = projectBounded(result.candidates, (left, right) =>
        left.name.localeCompare(right.name)
        || String(left.package_name ?? '').localeCompare(String(right.package_name ?? ''))
        || left.id - right.id);
      db.prepare('INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,unresolved_reason,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
        workspaceId,
        'REPO_IMPORTS_HELPER_PACKAGE',
        status,
        'repo',
        String(repo.id),
        helper ? 'repo' : 'repo_candidates',
        helper ? String(helper.id) : projection.items.map((candidate) => candidate.id).join(','),
        helper ? 1 : 0.5,
        JSON.stringify({
          dependency: dep,
          candidates: projection.items.map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            packageName: candidate.package_name,
          })),
          candidateCount: projection.totalCount,
          shownCandidateCount: projection.shownCount,
          omittedCandidateCount: projection.omittedCount,
          match: result.strategy,
        }),
        0,
        helper ? null : 'Ambiguous dependency package candidates',
        generation,
      );
      summary.edgeCount += 1;
      if (helper) summary.resolvedCount += 1;
      else summary.ambiguousCount += 1;
    }
  }
  return summary;
}
