import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { trace } from '../../src/trace/trace-engine.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

async function writeRepository(
  root: string,
  repo: string,
  handlerSource: string,
): Promise<void> {
  await writeFixtureFile(root, `${repo}/.git-fixture`);
  await writeFixtureFile(root, `${repo}/package.json`, JSON.stringify({
    name: `@neutral/${repo}`,
    version: '1.0.0',
  }));
  await writeFixtureFile(root, `${repo}/srv/Handlers.ts`, handlerSource);
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
}

describe('trace selector fail-closed behavior', () => {
  it('matches class-name prefixes literally when underscores are present', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-class-prefix-'));
    await writeRepository(root, 'prefix-service', `
      import { Handler, OnUpdate } from 'cds-routing-handlers';
      @Handler()
      export class A_B {
        @OnUpdate()
        async updateA(): Promise<void> {
          await fetch('https://example.invalid/a');
        }
      }
      @Handler()
      export class AxB {
        @OnUpdate()
        async updateX(): Promise<void> {
          await fetch('https://example.invalid/x');
        }
      }
    `);
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);

    const result = trace(db, {
      repo: 'prefix-service',
      handler: 'A_B',
    }, { depth: 4, includeExternal: true, workspaceId });
    const external = result.edges.filter((edge) => edge.type === 'external_http');
    expect(external).toHaveLength(1);
    expect(external[0]?.evidence.sourceLine).toBe(7);
    db.close();
  });

  it('does not select one handler-only operation fallback when scopes compete', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-operation-scope-'));
    for (const repo of ['first-service', 'second-service']) {
      await writeRepository(root, repo, `
        import { Action, Handler } from 'cds-routing-handlers';
        @Handler()
        export class ${repo === 'first-service' ? 'FirstHandler' : 'SecondHandler'} {
          @Action('sharedAction')
          async sharedMethod(): Promise<void> {
            await fetch('https://example.invalid/${repo}');
          }
        }
      `);
    }
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);

    const result = trace(db, { operation: 'sharedAction' }, {
      depth: 4,
      includeExternal: true,
      workspaceId,
    });
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    const diagnostic = result.diagnostics.find((item) =>
      item.code === 'trace_start_ambiguous');
    expect(diagnostic).toMatchObject({
      selectorKind: 'operation',
      normalizedSelectorValue: 'sharedAction',
      resolutionStatus: 'ambiguous_handler_operation',
    });
    expect(Array.isArray(diagnostic?.candidates)
      ? diagnostic.candidates
      : []).toHaveLength(2);
    db.close();
  });

  it('reports method ambiguity candidates at method source locations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-method-location-'));
    for (const repo of ['left-service', 'right-service']) {
      await writeRepository(root, repo, `
        import { Action, Handler } from 'cds-routing-handlers';
        @Handler()
        export class ${repo === 'left-service' ? 'LeftHandler' : 'RightHandler'} {
          @Action('sharedAction')
          async sharedMethod(): Promise<void> {}
        }
      `);
    }
    const { db, workspaceId } = await prepareWorkspace(root);
    const result = trace(db, { handler: 'sharedMethod' }, {
      depth: 4,
      workspaceId,
    });
    const diagnostic = result.diagnostics.find((item) =>
      item.code === 'trace_start_ambiguous');
    const candidates = recordArray(diagnostic?.candidates);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.sourceLine))
      .toEqual([5, 5]);
    db.close();
  });
});
