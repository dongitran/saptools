import { describe, it, expect, vi } from 'vitest';

import type { EventMeshBinding } from '../../src/eventMeshBindings.js';
import { EventMeshPublishClient } from '../../src/eventMeshPublishClient.js';

const mockBinding: EventMeshBinding = {
  index: 0,
  name: 'test',
  instanceName: 'test',
  namespace: 'ns',
  management: { uri: 'mock', oa2: { clientid: 'c', clientsecret: 's', tokenendpoint: 'https://token' } },
  messaging: { uri: 'https://msg', oa2: { clientid: 'c', clientsecret: 's', tokenendpoint: 'https://token' } },
  amqp: { uri: 'wss://amqp', oa2: { clientid: 'c', clientsecret: 's', tokenendpoint: 'https://token' } },
};

describe('EventMeshPublishClient Errors', () => {
  it('should throw on token fetch failure', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized'
    }));

    const client = new EventMeshPublishClient(mockBinding, mockFetch as never);
    await expect(client.publishEvent('topic', 't1', 'msg', 'text/plain')).rejects.toThrow('Token request HTTP 401: Unauthorized');
  });

  it('should throw on missing access_token in response', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      text: async () => JSON.stringify({})
    }));

    const client = new EventMeshPublishClient(mockBinding, mockFetch as never);
    await expect(client.publishEvent('topic', 't1', 'msg', 'text/plain')).rejects.toThrow('Messaging token response missing access_token');
  });

  it('should throw on publish HTTP failure', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('token')) {
        return { ok: true, text: async () => JSON.stringify({ access_token: 'tkn' }) };
      }
      return { ok: false, status: 500, text: async () => 'Internal Server Error' };
    });

    const client = new EventMeshPublishClient(mockBinding, mockFetch as never);
    await expect(client.publishEvent('topic', 't1', 'msg', 'text/plain')).rejects.toThrow('HTTP 500: Internal Server Error');
  });
});
