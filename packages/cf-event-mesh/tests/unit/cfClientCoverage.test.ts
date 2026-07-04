import { describe, it, expect, vi } from 'vitest';

import * as cfClient from '../../src/cfClient.js';

vi.mock('node:child_process', () => ({
  default: {
    execFile: vi.fn((cmd, args, cb) => {
      if (args.includes('fail-guid-stderr')) {
        cb(new Error('exit code 1'), '', 'cf app failed');
      } else if (args.includes('fail-env-empty')) {
        cb(null, JSON.stringify({ system_env_json: null }), '');
      } else if (args.includes('fail-env-no-em')) {
        cb(null, JSON.stringify({ system_env_json: {} }), '');
      } else if (args.includes('fail-guid-empty-stdout')) {
        cb(null, '   \n  ', '');
      } else if (args.includes('app') && args.includes('--guid')) {
        if (args.includes('empty-env')) {cb(null, 'empty', '');}
        else if (args.includes('no-em')) {cb(null, 'no-em', '');}
        else if (args.includes('empty-sys-env')) {cb(null, 'empty-sys-env', '');}
        else {cb(null, 'mock', '');}
      } else if (args.includes('curl') && args.includes('/v3/apps/empty/env')) {
        cb(null, 'null', '');
      } else if (args.includes('curl') && args.includes('/v3/apps/no-em/env')) {
        cb(null, JSON.stringify({ system_env_json: {} }), '');
      } else if (args.includes('curl') && args.includes('/v3/apps/empty-sys-env/env')) {
        cb(null, JSON.stringify({ system_env_json: null }), '');
      }
    })
  },
  execFile: vi.fn((cmd, args, cb) => {
    if (args.includes('fail-guid-stderr')) {
      cb(new Error('exit code 1'), '', 'cf app failed');
    } else if (args.includes('fail-env-empty')) {
      cb(null, JSON.stringify({ system_env_json: null }), '');
    } else if (args.includes('fail-env-no-em')) {
      cb(null, JSON.stringify({ system_env_json: {} }), '');
    } else if (args.includes('fail-guid-empty-stdout')) {
      cb(null, '   \n  ', '');
    } else if (args.includes('app') && args.includes('--guid')) {
      if (args.includes('empty-env')) {cb(null, 'empty', '');}
      else if (args.includes('no-em')) {cb(null, 'no-em', '');}
      else if (args.includes('empty-sys-env')) {cb(null, 'empty-sys-env', '');}
      else {cb(null, 'mock', '');}
    } else if (args.includes('curl') && args.includes('/v3/apps/empty/env')) {
      cb(null, 'null', '');
    } else if (args.includes('curl') && args.includes('/v3/apps/no-em/env')) {
      cb(null, JSON.stringify({ system_env_json: {} }), '');
    } else if (args.includes('curl') && args.includes('/v3/apps/empty-sys-env/env')) {
      cb(null, JSON.stringify({ system_env_json: null }), '');
    }
  })
}));

describe('cfClient coverage', () => {
  it('should throw if guid is empty string', async () => {
    await expect(cfClient.getAppGuid('fail-guid-empty-stdout')).rejects.toThrow('Could not find GUID');
  });

  it('should handle empty env response', async () => {
    await expect(cfClient.getEventMeshBindingsForApp('empty-env')).rejects.toThrow('Invalid env response');
  });

  it('should handle missing enterprise-messaging', async () => {
    const res = await cfClient.getEventMeshBindingsForApp('no-em');
    expect(res).toEqual([]);
  });

  it('should handle null system_env_json', async () => {
    // wait, getEventMeshBindingsForApp('fail-env-empty') will hit getAppGuid('fail-env-empty'), which isn't mapped to return 'fail-env-empty'.
    // Let's add mapping for 'empty-sys-env'.
    const res = await cfClient.getEventMeshBindingsForApp('empty-sys-env');
    expect(res).toEqual([]);
  });
});

