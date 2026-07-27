import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDecorators } from '../../src/parsers/decorator-parser.js';
import { loadRepositorySourceContext } from '../../src/parsers/ts-project.js';

async function decoratorResolution(
  generatedSource: string,
): Promise<Record<string, unknown> | undefined> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'service-flow-dotted-namespace-'),
  );
  await fs.writeFile(path.join(root, 'generated.ts'), generatedSource);
  await fs.writeFile(path.join(root, 'handler.ts'), `
    import { Func, Handler } from 'cds-routing-handlers';
    import { a } from './generated.js';
    @Handler()
    export class DottedHandler {
      @Func(a.b.C.E.name)
      run(): void {}
    }
  `);
  const context = await loadRepositorySourceContext(
    root, ['generated.ts', 'handler.ts'],
  );
  return (await parseDecorators(root, 'handler.ts', context))
    .flatMap((handler) => handler.methods)[0]?.decoratorResolution;
}

async function generatedModelResolutionKinds(): Promise<string[]> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'service-flow-generated-model-namespace-'),
  );
  await fs.mkdir(path.join(root, '@cds-models'), { recursive: true });
  await fs.writeFile(path.join(root, '@cds-models/model.ts'), `
    export namespace a.b.C {
      export enum First { name = 'firstOperation' }
      export enum Second { name = 'secondOperation' }
    }
  `);
  await fs.writeFile(path.join(root, 'handler.ts'), `
    import { Func, Handler } from 'cds-routing-handlers';
    import { a } from '#cds-models/model';
    @Handler()
    export class GeneratedHandler {
      @Func(a.b.C.First.name)
      first(): void {}
      @Func(a.b.C.Second.name)
      second(): void {}
    }
  `);
  const files = ['@cds-models/model.ts', 'handler.ts'];
  const context = await loadRepositorySourceContext(root, files);
  return (await parseDecorators(root, 'handler.ts', context))
    .flatMap((handler) => handler.methods)
    .map((method) => method.decoratorResolution.resolutionKind);
}

describe('dotted namespace decorator constants', () => {
  it('propagates an outer export through compiler nested-namespace nodes', async () => {
    const resolution = await decoratorResolution(`
      export namespace a.b.C {
        export enum E { name = 'resolvedOperation' }
      }
    `);

    expect(resolution).toMatchObject({
      resolutionKind: 'enum_member',
      resolvedValue: 'resolvedOperation',
    });
  });

  it('does not export a dotted namespace with no outer export', async () => {
    const resolution = await decoratorResolution(`
      namespace a.b.C {
        export enum E { name = 'privateOperation' }
      }
    `);

    expect(resolution).toMatchObject({
      resolutionKind: 'unresolved',
      unresolvedReason: 'decorator_constant_not_exported',
    });
  });

  it('keeps an unexported block-nested namespace private', async () => {
    const resolution = await decoratorResolution(`
      export namespace a {
        namespace b {
          export namespace C {
            export enum E { name = 'privateOperation' }
          }
        }
      }
    `);

    expect(resolution).toMatchObject({
      resolutionKind: 'unresolved',
      unresolvedReason: 'decorator_constant_not_exported',
    });
  });

  it('preserves the generated-model resolution distribution', async () => {
    const resolutionKinds = await generatedModelResolutionKinds();

    expect(resolutionKinds).toEqual([
      'generated_constant_name',
      'generated_constant_name',
    ]);
    expect(resolutionKinds.filter((kind) => kind === 'unresolved'))
      .toHaveLength(0);
  });
});
