import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDecorators } from '../../src/parsers/decorator-parser.js';
import type { HandlerClassFact } from '../../src/types.js';

async function parseSource(source: string): Promise<HandlerClassFact[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-lifecycle-safety-'));
  await writeFile(path.join(root, 'handler.ts'), source);
  return parseDecorators(root, 'handler.ts');
}

describe('lifecycle decorator provenance safety', () => {
  it('does not use a type-only import clause as runtime decorator evidence', async () => {
    const handlers = await parseSource(`
      import type { Handler, OnUpdate } from 'cds-routing-handlers';
      @Handler()
      export class TypeOnlyHandler {
        @OnUpdate() updateRecord(): void {}
      }
    `);

    expect(handlers[0]?.methods[0]).toMatchObject({
      handlerKind: 'unsupported_lifecycle',
      executable: false,
      decoratorResolution: {
        unresolvedReason: 'lifecycle_decorator_import_not_supported',
      },
    });
  });

  it('does not use a type-only import specifier as runtime decorator evidence', async () => {
    const handlers = await parseSource(`
      import { Handler, type OnUpdate } from 'cds-routing-handlers';
      @Handler()
      export class TypeSpecifierHandler {
        @OnUpdate() updateRecord(): void {}
      }
    `);

    expect(handlers[0]?.methods[0]).toMatchObject({
      handlerKind: 'unsupported_lifecycle',
      executable: false,
      decoratorResolution: {
        resolvedDecoratorKind: undefined,
        unresolvedReason: 'lifecycle_decorator_import_not_supported',
      },
    });
  });

  it('persists nonzero CRUD lifecycle arguments as unsupported evidence', async () => {
    const handlers = await parseSource(`
      import { Handler, OnUpdate, BeforeCreate } from 'cds-routing-handlers';
      const entity = 'Records';
      @Handler()
      export class ArgumentHandler {
        @OnUpdate(entity) updateRecord(): void {}
        @BeforeCreate('Records', 'Extra') createRecord(): void {}
      }
    `);
    const [oneArgument, twoArguments] = handlers[0]?.methods ?? [];

    expect(oneArgument).toMatchObject({
      handlerKind: 'unsupported_lifecycle',
      executable: false,
      decoratorResolution: {
        argumentExpression: 'entity',
        resolvedValue: 'Records',
        resolutionKind: 'const_identifier',
        unresolvedReason: 'lifecycle_decorator_arguments_not_supported',
      },
    });
    expect(twoArguments).toMatchObject({
      handlerKind: 'unsupported_lifecycle',
      executable: false,
      decoratorResolution: {
        resolutionKind: 'unresolved',
        unresolvedReason: 'unsupported_lifecycle_argument_count',
      },
    });
  });
});
