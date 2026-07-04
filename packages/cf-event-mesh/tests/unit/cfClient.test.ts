import { describe, it, expect, vi } from 'vitest';

import * as cfClient from '../../src/cfClient.js';

vi.mock('node:child_process', () => ({
  default: {
    execFile: vi.fn((cmd, args, cb) => {
      if (args.includes('fail-guid')) {
        cb(new Error('fail'), '', '');
      } else if (args.includes('fail-env')) {
        cb(null, 'mock-guid-2', '');
      } else if (args.includes('app') && args.includes('--guid')) {
        cb(null, 'mock-guid', '');
      } else if (args.includes('curl') && args.includes('/v3/apps/mock-guid/env')) {
        cb(null, JSON.stringify({
          system_env_json: {
            'enterprise-messaging': [{
              name: 'em-1',
              credentials: {
                namespace: 'ns',
                management: [{ uri: 'm', oa2: { clientid: 'c', clientsecret: 's', tokenendpoint: 't' } }],
                messaging: [
                  { protocol: ['httprest'], uri: 'm', oa2: { clientid: 'c', clientsecret: 's', tokenendpoint: 't' } },
                  { protocol: ['amqp10ws'], uri: 'a', oa2: { clientid: 'c', clientsecret: 's', tokenendpoint: 't' } }
                ]
              }
            }]
          }
        }), '');
      } else if (args.includes('curl') && args.includes('/v3/apps/mock-guid-2/env')) {
        cb(null, 'invalid-json', '');
      }
    })
  },
  execFile: vi.fn((cmd, args, cb) => {
    if (args.includes('fail-guid')) {
      cb(new Error('fail'), '', '');
    } else if (args.includes('fail-env')) {
      cb(null, 'mock-guid-2', '');
    } else if (args.includes('app') && args.includes('--guid')) {
      cb(null, 'mock-guid', '');
    } else if (args.includes('curl') && args.includes('/v3/apps/mock-guid/env')) {
      cb(null, JSON.stringify({
        system_env_json: {
          'enterprise-messaging': [{
            name: 'em-1',
            credentials: {
              namespace: 'ns',
              management: [{ uri: 'm', oa2: { clientid: 'c', clientsecret: 's', tokenendpoint: 't' } }],
              messaging: [
                { protocol: ['httprest'], uri: 'm', oa2: { clientid: 'c', clientsecret: 's', tokenendpoint: 't' } },
                { protocol: ['amqp10ws'], uri: 'a', oa2: { clientid: 'c', clientsecret: 's', tokenendpoint: 't' } }
              ]
            }
          }]
        }
      }), '');
    } else if (args.includes('curl') && args.includes('/v3/apps/mock-guid-2/env')) {
      cb(null, 'invalid-json', '');
    }
  })
}));

describe('cfClient', () => {
  it('should fetch guid', async () => {
    const guid = await cfClient.getAppGuid('my-app');
    expect(guid).toBe('mock-guid');
  });

  it('should throw on guid error', async () => {
    await expect(cfClient.getAppGuid('fail-guid')).rejects.toThrow('Failed to get app GUID');
  });

  it('should extract bindings', async () => {
    const bindings = await cfClient.getEventMeshBindingsForApp('my-app');
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.name).toBe('em-1');
  });

  it('should throw on invalid env response', async () => {
    await expect(cfClient.getEventMeshBindingsForApp('fail-env')).rejects.toThrow('Failed to fetch app env');
  });
});
