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

describe('service client binding propagation', () => {
  it('captures Promise.all array destructuring by index and ignores non-service elements', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-array-binding-'));
    await write(root, 'handler.ts', String.raw`import cds from '@sap/cds';
async function run(domain: string): Promise<void> {
  const [catalogClient, headers] = await Promise.all([
    cds.connect.to(` + '`' + `catalog_${'${domain}'}` + '`' + `, { kind: 'odata', credentials: { destination: ` + '`' + `catalog_${'${domain}'}` + '`' + `, path: ` + '`' + `/${'${domain}'}CatalogService` + '`' + ` } }),
    getHeaders(),
  ]);
  const [otherHeaders, workflowClient] = await Promise.all([getHeaders(), cds.connect.to('workflow_service')]);
  return { catalogClient, headers, otherHeaders, workflowClient };
}`);
    const rows = await parseServiceBindings(root, 'handler.ts');
    const catalog = rows.find((row) => row.variableName === 'catalogClient');
    expect(catalog?.servicePathExpr).toBe('/${domain}CatalogService');
    expect(catalog?.placeholders).toContain('domain');
    expect(catalog?.helperChain?.at(-1)).toMatchObject({ arrayIndex: 0, promiseAll: true });
    expect(rows.find((row) => row.variableName === 'workflowClient')?.helperChain?.at(-1)).toMatchObject({ arrayIndex: 1, promiseAll: true });
    expect(rows.some((row) => row.variableName === 'headers')).toBe(false);
    expect(rows.some((row) => row.variableName === 'otherHeaders')).toBe(false);
  });

  it('captures direct array destructuring and handles sparse/rest elements conservatively', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-direct-array-binding-'));
    await write(root, 'handler.ts', "import cds from '@sap/cds';\nasync function run(): Promise<void> {\n  const [catalogClient] = [await cds.connect.to('catalog_service')];\n  const [, workflowClient] = [getHeaders(), cds.connect.to('workflow_service')];\n  const [firstClient, ...rest] = [cds.connect.to('first_service'), cds.connect.to('ignored_service')];\n  return { catalogClient, workflowClient, firstClient, rest };\n}\n");
    const rows = await parseServiceBindings(root, 'handler.ts');
    expect(rows.find((row) => row.variableName === 'catalogClient')?.alias).toBe('catalog_service');
    expect(rows.find((row) => row.variableName === 'workflowClient')?.helperChain?.at(-1)).toMatchObject({ arrayIndex: 1, promiseAll: false });
    expect(rows.find((row) => row.variableName === 'firstClient')?.alias).toBe('first_service');
    expect(rows.some((row) => row.variableName === 'rest')).toBe(false);
  });

  it('captures helper returned transaction aliases directly and via object properties', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-helper-tx-binding-'));
    await write(root, 'helper.ts', String.raw`import cds from '@sap/cds';
export async function connectCatalog(domain: string, req: unknown) {
  const catalogClient = await cds.connect.to(` + '`' + `catalog_${'${domain}'}` + '`' + `, { kind: 'odata', credentials: { destination: ` + '`' + `catalog_${'${domain}'}` + '`' + `, path: ` + '`' + `/${'${domain}'}CatalogService` + '`' + ` } });
  const catalogTx = catalogClient.tx(req);
  return catalogTx;
}
export async function connectWorkflow(req: unknown) {
  const workflowClient = await cds.connect.to('workflow_service');
  const workflowTx = workflowClient.tx(req);
  return { workflowClient, workflowTx };
}
`);
    await write(root, 'handler.ts', "import { connectCatalog, connectWorkflow } from './helper.js';\nasync function run(domain: string, req: unknown): Promise<void> {\n  const client = await connectCatalog(domain, req);\n  const { workflowTx } = await connectWorkflow(req);\n  return { client, workflowTx };\n}\n");
    const rows = await parseServiceBindings(root, 'handler.ts');
    expect(rows.find((row) => row.variableName === 'client')?.helperChain).toEqual(expect.arrayContaining([expect.objectContaining({ aliasKind: 'transaction', transactionAliasSource: 'catalogClient' })]));
    expect(rows.find((row) => row.variableName === 'workflowTx')?.helperChain).toEqual(expect.arrayContaining([expect.objectContaining({ aliasKind: 'transaction', transactionAliasSource: 'workflowClient' }), expect.objectContaining({ returnedProperty: 'workflowTx' })]));
  });
});
