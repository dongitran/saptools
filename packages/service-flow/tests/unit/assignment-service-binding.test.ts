import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseServiceBindings } from '../../src/parsers/service-binding-parser.js';

async function write(root: string, rel: string, text: string): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

describe('assignment expression service bindings', () => {
  it('keeps declaration initializer bindings working', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-assignment-'));
    await write(root, 'handler.ts', "import cds from '@sap/cds';\nasync function run() {\n  const client = await cds.connect.to('RemoteService');\n}\n");
    const rows = await parseServiceBindings(root, 'handler.ts');
    expect(rows).toMatchObject([{ variableName: 'client', alias: 'RemoteService', sourceLine: 3 }]);
  });

  it('parses late direct cds.connect.to assignments', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-assignment-'));
    await write(root, 'handler.ts', "import cds from '@sap/cds';\nasync function run() {\n  let client;\n  client = await (cds.connect.to('RemoteService') as unknown);\n}\n");
    const rows = await parseServiceBindings(root, 'handler.ts');
    expect(rows.find((row) => row.variableName === 'client')).toMatchObject({ alias: 'RemoteService', sourceLine: 4 });
    expect(rows.find((row) => row.variableName === 'client')?.helperChain?.[0]).toMatchObject({ callerVariable: 'client', aliasKind: 'assignment', scopeRule: 'same-file-source-order' });
  });

  it('parses late assignments from imported helpers returning a client', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-assignment-'));
    await write(root, 'helper.ts', "import cds from '@sap/cds';\nexport async function connectRemoteService() {\n  return cds.connect.to('RemoteService');\n}\n");
    await write(root, 'handler.ts', "import { connectRemoteService } from './helper.js';\nasync function run() {\n  let client;\n  client = await connectRemoteService();\n}\n");
    const rows = await parseServiceBindings(root, 'handler.ts');
    expect(rows.find((row) => row.variableName === 'client')).toMatchObject({ alias: 'RemoteService', sourceLine: 4 });
    expect(rows.find((row) => row.variableName === 'client')?.helperChain?.[0]).toMatchObject({ assignedFrom: 'connectRemoteService', aliasKind: 'assignment' });
  });

  it('parses late destructuring assignments from helpers returning object properties', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-assignment-'));
    await write(root, 'helper.ts', "import cds from '@sap/cds';\nexport async function connectRemoteServices() {\n  const serviceClient = await cds.connect.to('RemoteService');\n  return { serviceClient };\n}\n");
    await write(root, 'handler.ts', "import { connectRemoteServices } from './helper.js';\nasync function run() {\n  let serviceClient;\n  ({ serviceClient } = await connectRemoteServices());\n}\n");
    const rows = await parseServiceBindings(root, 'handler.ts');
    expect(rows.find((row) => row.variableName === 'serviceClient')).toMatchObject({ alias: 'RemoteService', sourceLine: 4 });
  });

  it('parses renamed destructuring assignments', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-assignment-'));
    await write(root, 'helper.ts', "import cds from '@sap/cds';\nexport async function connectRemoteServices() {\n  const serviceClient = await cds.connect.to('RemoteService');\n  return { serviceClient };\n}\n");
    await write(root, 'handler.ts', "import { connectRemoteServices } from './helper.js';\nasync function run() {\n  let renamedClient;\n  ({ serviceClient: renamedClient } = await connectRemoteServices());\n}\n");
    const rows = await parseServiceBindings(root, 'handler.ts');
    expect(rows.find((row) => row.variableName === 'renamedClient')).toMatchObject({ alias: 'RemoteService', sourceLine: 4 });
    expect(rows.find((row) => row.variableName === 'renamedClient')?.helperChain?.[0]).toMatchObject({ returnedProperty: 'serviceClient' });
  });

  it('parses identity assignment after a late assignment', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-assignment-'));
    await write(root, 'handler.ts', "import cds from '@sap/cds';\nasync function run() {\n  let client;\n  let tx;\n  client = cds.connect.to('RemoteService');\n  tx = client;\n}\n");
    const rows = await parseServiceBindings(root, 'handler.ts');
    expect(rows.find((row) => row.variableName === 'tx')).toMatchObject({ alias: 'RemoteService', sourceLine: 6 });
    expect(rows.find((row) => row.variableName === 'tx')?.helperChain?.at(-1)).toMatchObject({ aliasOf: 'client', aliasKind: 'identity-assignment' });
  });

  it('emits source-line-specific rows for multiple assignments to the same variable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-assignment-'));
    await write(root, 'handler.ts', "import cds from '@sap/cds';\nasync function run() {\n  let client;\n  client = cds.connect.to('FirstService');\n  client = cds.connect.to('SecondService');\n}\n");
    const rows = (await parseServiceBindings(root, 'handler.ts')).filter((row) => row.variableName === 'client');
    expect(rows.map((row) => [row.alias, row.sourceLine])).toEqual([['FirstService', 4], ['SecondService', 5]]);
  });

  it('does not infer unsupported property assignments', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-assignment-'));
    await write(root, 'handler.ts', "import cds from '@sap/cds';\nclass Helper {\n  async run() {\n    this.client = await cds.connect.to('RemoteService');\n  }\n}\n");
    const rows = await parseServiceBindings(root, 'handler.ts');
    expect(rows).toHaveLength(0);
  });
});
