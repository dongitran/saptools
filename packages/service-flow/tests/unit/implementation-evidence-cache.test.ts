import { cp, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/connection.js';
import {
  canonicalImplementationEvidence,
  resetCanonicalImplementationEvidence,
} from '../../src/linker/implementation-candidates.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { prepareWorkspace } from './test-workspace.js';

const fixture = path.resolve(
  'tests/fixtures/implementation-resolution-workspace',
);

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
}

async function preparedFixture(): ReturnType<typeof prepareWorkspace> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'service-flow-canonical-cache-'),
  );
  const workspace = path.join(root, 'workspace');
  await cp(fixture, workspace, { recursive: true });
  return prepareWorkspace(workspace);
}

function operationId(db: Db): number {
  const row = db.prepare(`SELECT o.id
    FROM cds_operations o
    WHERE o.operation_name='runSharedCheck'`).get();
  const id = Number(row?.id);
  if (!Number.isFinite(id)) throw new Error('Expected runSharedCheck operation');
  return id;
}

function candidateRepositories(
  evidence: Record<string, unknown> | undefined,
): string[] {
  return records(evidence?.candidates)
    .map((candidate) => {
      const handler = candidate.handlerPackage;
      return handler && typeof handler === 'object' && !Array.isArray(handler)
        ? String((handler as Record<string, unknown>).name)
        : '';
    })
    .filter(Boolean)
    .sort();
}

describe('canonical implementation evidence cache', () => {
  it('reuses one decision for repeated reads of an operation', async () => {
    const current = await preparedFixture();
    linkWorkspace(current.db, current.workspaceId);
    const id = operationId(current.db);
    let candidateQueries = 0;
    const counted: Db = {
      ...current.db,
      prepare: (sql) => {
        if (sql.includes('SELECT DISTINCT')
          && sql.includes('FROM handler_methods hm'))
          candidateQueries += 1;
        return current.db.prepare(sql);
      },
    };
    resetCanonicalImplementationEvidence(counted);

    const first = canonicalImplementationEvidence(counted, id);
    const second = canonicalImplementationEvidence(counted, String(id));
    expect(second).toBe(first);
    expect(candidateQueries).toBe(1);
    current.db.close();
  });

  it('resets cached decisions before a same-process relink', async () => {
    const current = await preparedFixture();
    linkWorkspace(current.db, current.workspaceId);
    const id = operationId(current.db);
    resetCanonicalImplementationEvidence(current.db);
    const before = canonicalImplementationEvidence(current.db, id);
    expect(candidateRepositories(before)).toEqual(['helper-a', 'helper-b']);

    current.db.prepare(`DELETE FROM handler_registrations
      WHERE repo_id=(SELECT id FROM repositories WHERE name='helper-b')
        AND class_name='SharedProcessHandler'`).run();
    linkWorkspace(current.db, current.workspaceId);

    const after = canonicalImplementationEvidence(current.db, id);
    expect(candidateRepositories(after)).toEqual(['helper-a']);
    const edge = current.db.prepare(`SELECT status
      FROM graph_edges
      WHERE edge_type='OPERATION_IMPLEMENTED_BY_HANDLER'
        AND from_id=?`).get(String(id));
    expect(edge?.status).toBe('resolved');
    current.db.close();
  });
});
