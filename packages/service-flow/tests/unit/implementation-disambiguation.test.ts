import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { linkWorkspace, trace } from '../../src/index.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

async function createDuplicatePackageImplementationFixture(root: string): Promise<void> {
  await writeFixtureFile(root, 'model-core/.git-fixture');
  await writeFixtureFile(root, 'model-core/package.json', JSON.stringify({ name: '@neutral/model-core', version: '1.0.0' }));
  await writeFixtureFile(root, 'model-core/srv/shared.cds', 'service SharedService { action syncData(); }');

  for (const repo of ['helper-alpha', 'helper-beta']) {
    const className = repo === 'helper-alpha' ? 'AlphaSyncHandler' : 'BetaSyncHandler';
    const entityName = repo === 'helper-alpha' ? 'AlphaLogs' : 'BetaLogs';
    await writeFixtureFile(root, `${repo}/.git-fixture`);
    await writeFixtureFile(root, `${repo}/package.json`, JSON.stringify({ name: '@neutral/shared-helper', version: '1.0.0' }));
    await writeFixtureFile(root, `${repo}/src/${className}.ts`, `import cds from '@sap/cds';
import { Handler, Action } from 'cds-routing-handlers';
@Handler()
export class ${className} {
  @Action('syncData')
  async syncData(): Promise<void> {
    await cds.run(SELECT.from(${entityName}));
  }
}
`);
    await writeFixtureFile(root, `${repo}/src/server.ts`, `import { createCombinedHandler } from 'cds-routing-handlers';
import { ${className} } from './${className}.js';
createCombinedHandler({ handler: [${className}] });
`);
  }
}

describe('implementation duplicate package disambiguation', () => {
  it('keeps duplicate package-name implementation candidates ambiguous without a hint', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-duplicate-package-'));
    await createDuplicatePackageImplementationFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    const linked = linkWorkspace(db, workspaceId);
    expect(linked.implementationAmbiguousCount).toBe(1);

    const edge = db.prepare("SELECT status,unresolved_reason unresolvedReason,evidence_json evidenceJson FROM graph_edges WHERE edge_type='OPERATION_IMPLEMENTED_BY_HANDLER'").get() as { status: string; unresolvedReason: string; evidenceJson: string };
    expect(edge.status).toBe('ambiguous');
    expect(edge.unresolvedReason).toContain('Ambiguous');
    const evidence = JSON.parse(edge.evidenceJson) as {
      ambiguityReasons?: string[];
      candidateFamilies?: Array<{ reason: string; packageName: string; count: number }>;
      candidates: Array<{ handlerPackage: { name: string; packageName: string }; accepted: boolean }>;
    };
    expect(evidence.ambiguityReasons).toContain('duplicate_package_name_candidates');
    expect(evidence.candidateFamilies).toContainEqual(expect.objectContaining({
      reason: 'duplicate_package_name_candidates',
      packageName: '@neutral/shared-helper',
      count: 2,
    }));
    expect(evidence.candidates.map((candidate) => candidate.handlerPackage.name).sort()).toEqual(['helper-alpha', 'helper-beta']);

    const result = trace(db, { servicePath: '/SharedService', operation: 'syncData' }, { depth: 5, includeDb: true });
    expect(result.edges).toHaveLength(0);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'trace_start_ambiguous',
      resolutionStatus: 'ambiguous_implementation',
      implementationAmbiguityReasons: ['duplicate_package_name_candidates'],
    }));
    db.close();
  });

  it('continues through a hinted implementation repository and marks the selection guided', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-hinted-package-'));
    await createDuplicatePackageImplementationFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);

    const result = trace(db, { servicePath: '/SharedService', operation: 'syncData' }, {
      depth: 5,
      includeDb: true,
      implementationRepo: 'helper-alpha',
    });

    const implEdge = result.edges.find((edge) => edge.type === 'operation_implemented_by_handler');
    expect(implEdge?.to).toContain('AlphaSyncHandler.syncData');
    expect(implEdge?.unresolvedReason).toBeUndefined();
    expect(implEdge?.evidence).toMatchObject({
      implementationSelection: {
        guided: true,
        strategy: 'implementation_repo_hint',
        selectedRepo: 'helper-alpha',
        ambiguityReason: 'duplicate_package_name_candidates',
      },
    });
    expect(result.edges.some((edge) => edge.type === 'local_db_query' && String(edge.to).includes('AlphaLogs'))).toBe(true);
    expect(result.edges.some((edge) => String(edge.to).includes('BetaLogs'))).toBe(false);
    db.close();
  });
});
