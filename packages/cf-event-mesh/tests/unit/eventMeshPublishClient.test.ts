import { describe, it, expect, vi } from 'vitest';

import type { EventMeshBinding } from '../../src/eventMeshBindings.js';
import { EventMeshPublishClient, publishEventToMesh, publishEventToMeshQueue } from '../../src/eventMeshPublishClient.js';

const mockBinding: EventMeshBinding = {
  index: 0,
  name: 'test',
  instanceName: 'test',
  namespace: 'ns',
  management: { uri: 'mock', oa2: { clientid: 'c', clientsecret: 's', tokenendpoint: 'https://token' } },
  messaging: { uri: 'https://msg', oa2: { clientid: 'c', clientsecret: 's', tokenendpoint: 'https://token' } },
  amqp: { uri: 'wss://amqp', oa2: { clientid: 'c', clientsecret: 's', tokenendpoint: 'https://token' } },
};

describe('EventMeshPublishClient', () => {
  it('should publish successfully', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('token')) {
        return {
          ok: true,
          text: async () => JSON.stringify({ access_token: 'tkn', expires_in: 3600 })
        };
      }
      return {
        ok: true,
        status: 204
      };
    });

    const client = new EventMeshPublishClient(mockBinding, mockFetch as never);
    const status = await client.publishEvent('topic', 't1', 'msg', 'text/plain');
    expect(status).toBe(204);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should reuse token if not expired', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('token')) {
        return {
          ok: true,
          text: async () => JSON.stringify({ access_token: 'tkn', expires_in: 3600 })
        };
      }
      return { ok: true, status: 204 };
    });

    const client = new EventMeshPublishClient(mockBinding, mockFetch as never);
    await client.publishEvent('topic', 't1', 'msg', 'text/plain');
    await client.publishEvent('topic', 't2', 'msg', 'text/plain');
    
    // Token fetched once, publish called twice = 3 calls
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('should use global cache in helper functions', async () => {
    const globalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('token')) {
        return { ok: true, text: async () => JSON.stringify({ access_token: 'tkn', expires_in: 3600 }) };
      }
      return { ok: true, status: 204 };
    });

    try {
      await publishEventToMesh(mockBinding, 't1', 'msg', 'text/plain');
      await publishEventToMeshQueue(mockBinding, 'q1', 'msg', 'text/plain');
      
      expect(global.fetch).toHaveBeenCalledTimes(3);
    } finally {
      global.fetch = globalFetch;
    }
  });
});
