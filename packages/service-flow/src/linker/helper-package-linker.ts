import type { Db } from '../db/connection.js';
export function linkHelperPackages(db: Db, workspaceId: number): number {
  const repos = db
    .prepare(
      'SELECT id,name,dependencies_json FROM repositories WHERE workspace_id=?'
    )
    .all(workspaceId) as Array<{
    id: number;
    name: string;
    dependencies_json: string;
  }>;
  let count = 0;
  for (const repo of repos) {
    const deps = JSON.parse(repo.dependencies_json) as Record<string, string>;
    for (const dep of Object.keys(deps)) {
      const helper = repos.find((r) => r.name === dep || dep.endsWith(r.name));
      if (helper) {
        db.prepare(
          'INSERT INTO graph_edges(workspace_id,edge_type,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic) VALUES(?,?,?,?,?,?,?,?,?)'
        ).run(
          workspaceId,
          'REPO_IMPORTS_HELPER_PACKAGE',
          'repo',
          String(repo.id),
          'repo',
          String(helper.id),
          0.9,
          JSON.stringify({ dependency: dep }),
          0
        );
        count += 1;
      }
    }
  }
  return count;
}
