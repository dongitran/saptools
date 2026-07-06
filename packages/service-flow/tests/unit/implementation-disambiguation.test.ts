import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { linkWorkspace, trace } from '../../src/index.js';
import { parseImplementationHint } from '../../src/trace/implementation-hints.js';
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

async function createTwoHopImplementationFixture(root: string): Promise<void> {
  await writeFixtureFile(root, 'flow-model/.git-fixture');
  await writeFixtureFile(root, 'flow-model/package.json', JSON.stringify({ name: '@neutral/flow-model', version: '1.0.0' }));
  await writeFixtureFile(root, 'flow-model/srv/flow.cds', 'service EntryService { action beginFlow(); }\nservice CompletionService { action finishFlow(); }');

  for (const repo of ['entry-helper-east', 'entry-helper-west']) {
    const effectiveSuffix = repo.endsWith('east') ? 'East' : 'West';
    await writeFixtureFile(root, `${repo}/.git-fixture`);
    await writeFixtureFile(root, `${repo}/package.json`, JSON.stringify({ name: '@neutral/entry-helper', version: '1.0.0' }));
    await writeFixtureFile(root, `${repo}/src/Begin${effectiveSuffix}Handler.ts`, `import cds from '@sap/cds';
import { Handler, Action } from 'cds-routing-handlers';
@Handler()
export class Begin${effectiveSuffix}Handler {
  @Action('beginFlow')
  async beginFlow(): Promise<void> {
    const completionClient = await cds.connect.to('completion', { credentials: { path: '/CompletionService' } });
    await completionClient.send('finishFlow', {});
  }
}
`);
    await writeFixtureFile(root, `${repo}/src/server.ts`, `import { createCombinedHandler } from 'cds-routing-handlers';
import { Begin${effectiveSuffix}Handler } from './Begin${effectiveSuffix}Handler.js';
createCombinedHandler({ handler: [Begin${effectiveSuffix}Handler] });
`);
  }
  for (const repo of ['completion-helper-north', 'completion-helper-south']) {
    const suffix = repo.endsWith('north') ? 'North' : 'South';
    await writeFixtureFile(root, `${repo}/.git-fixture`);
    await writeFixtureFile(root, `${repo}/package.json`, JSON.stringify({ name: '@neutral/completion-helper', version: '1.0.0' }));
    await writeFixtureFile(root, `${repo}/src/Finish${suffix}Handler.ts`, `import cds from '@sap/cds';
import { Handler, Action } from 'cds-routing-handlers';
@Handler()
export class Finish${suffix}Handler {
  @Action('finishFlow')
  async finishFlow(): Promise<void> {
    await cds.run(SELECT.from(${suffix}Results));
  }
}
`);
    await writeFixtureFile(root, `${repo}/src/server.ts`, `import { createCombinedHandler } from 'cds-routing-handlers';
import { Finish${suffix}Handler } from './Finish${suffix}Handler.js';
createCombinedHandler({ handler: [Finish${suffix}Handler] });
`);
  }
}

describe('implementation duplicate package disambiguation', () => {
  it('parses a scoped CLI hint with explicit scope and selection fields', () => {
    expect(parseImplementationHint('service=/EntryService,operation=/beginFlow,package=@neutral/flow-model,repository=flow-model,family=@neutral/entry-helper,repo=entry-helper-east')).toEqual({
      servicePath: '/EntryService',
      operationPath: '/beginFlow',
      packageName: '@neutral/flow-model',
      repositoryName: 'flow-model',
      candidateFamily: '@neutral/entry-helper',
      implementationRepo: 'entry-helper-east',
    });
    expect(() => parseImplementationHint('service=/EntryService')).toThrow('implementation repo');
    expect(() => parseImplementationHint('unknown=value,repo=helper')).toThrow('Unknown implementation hint field');
  });

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

  it('applies multiple scoped implementation hints only to matching hops', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-scoped-hints-'));
    await createTwoHopImplementationFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);

    const oneHint = trace(db, { servicePath: '/EntryService', operation: 'beginFlow' }, {
      depth: 8,
      includeDb: true,
      implementationHints: [{
        servicePath: '/EntryService',
        operationPath: '/beginFlow',
        candidateFamily: '@neutral/entry-helper',
        implementationRepo: 'entry-helper-east',
      }],
    });
    expect(oneHint.edges.some((edge) => edge.type === 'remote_action' && edge.to.includes('finishFlow'))).toBe(true);
    const unresolvedCompletion = oneHint.edges.find((edge) =>
      edge.type === 'operation_implemented_by_handler' && edge.from.includes('/CompletionService/finishFlow'));
    expect(unresolvedCompletion?.unresolvedReason).toContain('Ambiguous');
    expect(unresolvedCompletion?.evidence).toMatchObject({
      implementationSelection: {
        status: 'not_matched',
        reason: 'no_scoped_hint_matched_edge',
      },
    });

    const twoHints = trace(db, { servicePath: '/EntryService', operation: 'beginFlow' }, {
      depth: 8,
      includeDb: true,
      implementationHints: [
        {
          servicePath: '/EntryService',
          operationPath: '/beginFlow',
          implementationRepo: 'entry-helper-east',
        },
        {
          servicePath: '/CompletionService',
          operationPath: '/finishFlow',
          packageName: '@neutral/flow-model',
          repositoryName: 'flow-model',
          candidateFamily: '@neutral/completion-helper',
          implementationRepo: 'completion-helper-south',
        },
      ],
    });
    expect(twoHints.edges.map((edge) => `${edge.type}:${edge.to}`)).toContain('local_db_query:Entity: SouthResults');
    expect(twoHints.edges.some((edge) => edge.type === 'local_db_query' && String(edge.to).includes('EastResults'))).toBe(false);
    const guidedEdges = twoHints.edges.filter((edge) => edge.type === 'operation_implemented_by_handler');
    expect(guidedEdges).toHaveLength(2);
    const selections = JSON.stringify(guidedEdges.map((edge) => edge.evidence.implementationSelection));
    expect(selections).toContain('"guided":true');
    expect(selections).toContain('"strategy":"scoped_implementation_hint"');
    expect(selections).toContain('"servicePath":"/EntryService"');
    expect(selections).toContain('"implementationRepo":"entry-helper-east"');
    expect(selections).toContain('"servicePath":"/CompletionService"');
    expect(selections).toContain('"implementationRepo":"completion-helper-south"');
    db.close();
  });

  it('keeps a scoped hint unresolved when its selection matches zero candidates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-bad-scoped-hint-'));
    await createTwoHopImplementationFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);

    const result = trace(db, { servicePath: '/EntryService', operation: 'beginFlow' }, {
      depth: 8,
      includeDb: true,
      implementationHints: [{
        servicePath: '/EntryService',
        operationPath: '/beginFlow',
        implementationRepo: 'helper-missing',
      }],
    });

    expect(result.edges).toHaveLength(0);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'implementation_hint_mismatch',
      hintStatus: 'not_matched',
      candidateCount: 0,
    }));

    const tied = trace(db, { servicePath: '/EntryService', operation: 'beginFlow' }, {
      depth: 8,
      implementationHints: [{
        servicePath: '/EntryService',
        implementationRepo: '@neutral/entry-helper',
      }],
    });
    expect(tied.edges).toHaveLength(0);
    expect(tied.diagnostics).toContainEqual(expect.objectContaining({
      code: 'implementation_hint_mismatch',
      hintStatus: 'tied',
      candidateCount: 2,
    }));
    db.close();
  });
});
