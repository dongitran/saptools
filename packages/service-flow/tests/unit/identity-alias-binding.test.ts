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

describe('identity alias service bindings', () => {
  it('propagates direct, typed, as, satisfies, helper-returned, and transitive aliases', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-identity-alias-'));
    await write(root, 'helper.ts', `
      import cds from '@sap/cds';
      export async function connectDomainClient(domainInfo: { serviceName: string }) {
        const client = await cds.connect.to({ credentials: { destination: 'catalog-service', path: '/CatalogService' } });
        return { client };
      }
    `);
    await write(root, 'handler.ts', `
      import cds from '@sap/cds';
      import { connectDomainClient } from './helper.js';
      async function runFlow(domainInfo: { serviceName: string }) {
        const client = await cds.connect.to('catalog-service');
        const tx = client;
        const typedTx: unknown = client;
        const asTx = client as unknown;
        const satisfiesTx = client satisfies unknown;
        const sender = tx;
        const { client: helperClient } = await connectDomainClient(domainInfo);
        const helperTx = helperClient;
        return { tx, typedTx, asTx, satisfiesTx, sender, helperTx };
      }
    `);
    const rows = await parseServiceBindings(root, 'handler.ts');
    for (const name of ['client', 'tx', 'typedTx', 'asTx', 'satisfiesTx', 'sender', 'helperClient', 'helperTx']) {
      expect(rows.some((row) => row.variableName === name)).toBe(true);
    }
    expect(rows.find((row) => row.variableName === 'tx')?.helperChain?.at(-1)).toMatchObject({ callerVariable: 'tx', aliasOf: 'client', aliasKind: 'identity' });
    expect(rows.find((row) => row.variableName === 'sender')?.helperChain?.at(-1)).toMatchObject({ callerVariable: 'sender', aliasOf: 'tx', aliasKind: 'identity' });
    expect(rows.find((row) => row.variableName === 'helperTx')?.helperChain).toEqual(expect.arrayContaining([expect.objectContaining({ returnedProperty: 'client' }), expect.objectContaining({ aliasOf: 'helperClient', aliasKind: 'identity' })]));
  });

  it('does not infer aliases from non-client variables, property access, calls, or forward aliases', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-identity-negative-'));
    await write(root, 'handler.ts', `
      import cds from '@sap/cds';
      async function runFlow() {
        const label = 'catalog-service';
        const notClient = label;
        const propertyAlias = holder.client;
        const callAlias = createClient();
        const early = late;
        const late = await cds.connect.to('catalog-service');
        return { notClient, propertyAlias, callAlias, early, late };
      }
    `);
    const rows = await parseServiceBindings(root, 'handler.ts');
    expect(rows.map((row) => row.variableName)).toEqual(['late']);
  });
});
