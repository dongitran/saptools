import { PassThrough } from 'node:stream';

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { createEntity } from '../src/discovery.js';
import { buildCurlCommands, formatResponse, promptAndRunRequest, runDiscoveredRequest } from '../src/runner.js';

describe('runner utilities', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('generates copy-ready curl commands with bearer token and payload placeholders', () => {
    const commands = buildCurlCommands({
      baseUrl: 'https://example.test/',
      token: 'resolved-token',
      entities: [createEntity('Books', '/odata/v4/catalog/Books', ['GET', 'POST'])],
    });

    expect(commands).toEqual([
      "curl --fail-with-body --show-error -X 'GET' 'https://example.test/odata/v4/catalog/Books' -H 'Accept: application/json' -H 'Authorization: Bearer resolved-token'",
      "curl --fail-with-body --show-error -X 'POST' 'https://example.test/odata/v4/catalog/Books' -H 'Accept: application/json' -H 'Authorization: Bearer resolved-token' -H 'Content-Type: application/json' --data '{}'",
    ]);
  });

  it('executes a discovered endpoint with authorization, timeout, and JSON payload', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      status: 201,
      statusText: 'Created',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ ok: true }),
    } as Response);

    const result = await runDiscoveredRequest({
      baseUrl: 'https://example.test',
      token: 'Bearer resolved-token',
      endpoint: createEntity('Books', '/odata/v4/catalog/Books', ['POST']),
      method: 'POST',
      payload: '{ "title": "Clean Code" }',
      timeoutMs: 1234,
    });

    expect(result.body).toEqual({ ok: true });
    expect(vi.mocked(global.fetch)).toHaveBeenCalledWith(
      'https://example.test/odata/v4/catalog/Books',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer resolved-token',
          'Content-Type': 'application/json',
        },
        signal: expect.any(AbortSignal),
        body: JSON.stringify({ title: 'Clean Code' }),
      },
    );
  });

  it('can drive interactive prompts through injected streams', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ value: [] }),
    } as Response);
    const input = new PassThrough();
    const output = new PassThrough();
    let capturedOutput = '';
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => { capturedOutput += chunk; });

    const resultPromise = promptAndRunRequest({
      appId: 'my-app',
      baseUrl: 'https://example.test',
      token: 'interactive-token',
      entities: [createEntity('Books', '/odata/v4/catalog/Books', ['GET', 'POST'])],
      input,
      output,
    });
    setTimeout(() => { input.write('1\n'); }, 0);
    setTimeout(() => { input.end('1\n'); }, 10);

    const result = await resultPromise;

    expect(result.status).toBe(200);
    expect(capturedOutput).toContain('Select an endpoint for my-app');
    expect(capturedOutput).toContain('Select HTTP method');
    expect(vi.mocked(global.fetch)).toHaveBeenCalledWith(
      'https://example.test/odata/v4/catalog/Books',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer interactive-token',
        },
      }),
    );
  });

  it('formats undefined response values without throwing', () => {
    expect(formatResponse({
      status: 204,
      statusText: 'No Content',
      headers: {},
      body: undefined,
    })).toContain('undefined');
  });

});
