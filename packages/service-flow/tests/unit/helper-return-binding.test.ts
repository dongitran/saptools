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

describe('helper returned object service bindings', () => {
  it('extracts local object shorthand, explicit properties, aliases, imports, and transactions conservatively', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-helper-binding-'));
    await write(root, 'helper.ts', String.raw`import cds from '@sap/cds';
export async function connectImportedContext(domainInfo) {
  const client = await cds.connect.to({ credentials: { destination: ` + '`' + `svc_\${domainInfo.shortName?.toLowerCase()}` + '`' + `, path: ` + '`' + `/\${domainInfo.serviceName}Service` + '`' + ` } });
  return { serviceClient: client, domainInfo };
}
`);
    await write(root, 'handler.ts', String.raw`import cds from '@sap/cds';
import { connectImportedContext } from './helper.js';
async function connectDomainContext(domain) {
  const client = await cds.connect.to({ credentials: { path: ` + '`' + `/\${domain}Service` + '`' + ` } });
  return { client };
}
async function connectExplicitContext(domain) {
  const client = await cds.connect.to({ credentials: { path: ` + '`' + `/\${domain}OtherService` + '`' + ` } });
  return { serviceClient: client };
}
async function unrelated() { return { client: {} }; }
async function run(domain, domainInfo) {
  const direct = await cds.connect.to('DirectService');
  const { client: domainClient } = await connectDomainContext(domain);
  const { serviceClient } = await connectExplicitContext(domain);
  const { serviceClient: importedClient } = await connectImportedContext(domainInfo);
  const { client: ignoredClient } = await unrelated();
  const tx = domainClient.tx();
  return { direct, domainClient, serviceClient, importedClient, ignoredClient, tx };
}
`);
    const rows = await parseServiceBindings(root, 'handler.ts');
    expect(rows.find((row) => row.variableName === 'direct')?.alias).toBe('DirectService');
    expect(rows.find((row) => row.variableName === 'domainClient')?.helperChain?.[0]).toMatchObject({ returnedProperty: 'client' });
    expect(rows.find((row) => row.variableName === 'serviceClient')?.helperChain?.[0]).toMatchObject({ returnedProperty: 'serviceClient' });
    expect(rows.find((row) => row.variableName === 'importedClient')?.placeholders).toContain('domainInfo.serviceName');
    expect(rows.find((row) => row.variableName === 'importedClient')?.placeholders).toContain('domainInfo.shortName?.toLowerCase()');
    expect(rows.find((row) => row.variableName === 'tx')?.helperChain?.at(-1)).toMatchObject({ aliasOf: 'domainClient', aliasKind: 'transaction' });
    expect(rows.some((row) => row.variableName === 'ignoredClient')).toBe(false);
  });
});
