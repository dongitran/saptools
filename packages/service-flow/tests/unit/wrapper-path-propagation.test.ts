import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOutboundCalls } from '../../src/parsers/outbound-call-parser.js';

async function write(root: string, text: string): Promise<void> {
  await fs.writeFile(path.join(root, 'handler.ts'), text);
}

describe('local wrapper path propagation', () => {
  it('resolves same-file literal path wrapper calls while preserving dynamic wrapper sends', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-wrapper-'));
    await write(root, `
      const sendWithClient = (client: unknown, method: string, path: string, headers: unknown) => {
        return async () => client.send({ method, path, headers });
      };
      export async function runFlow(catalogClient: unknown, headers: unknown) {
        await sendWithClient(catalogClient, 'GET', '/loadCatalog()', headers)();
        const dynamicPath = headers.path;
        await sendWithClient(catalogClient, 'GET', dynamicPath, headers)();
      }
    `);
    const calls = await parseOutboundCalls(root, 'handler.ts');
    expect(calls.some((call) => call.operationPathExpr === '/loadCatalog()' && call.evidence?.classifier === 'higher_order_wrapper_literal_path')).toBe(true);
    expect(calls.some((call) => call.unresolvedReason === 'dynamic_operation_path_identifier')).toBe(true);
  });
});
