import { ChildProcess, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as cfClient from '../src/cfClient.js';

interface OriginalChildProcessModule {
  readonly ChildProcess: typeof ChildProcess;
}

type MockChildProcess = ChildProcessWithoutNullStreams & {
  readonly stderr: PassThrough;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
};

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<OriginalChildProcessModule>();
  return { ChildProcess: original.ChildProcess, spawn: vi.fn() };
});

function createMockChild(): MockChildProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return Object.assign(new ChildProcess(), {
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr, null, null] as const,
    kill: vi.fn(() => true),
  });
}

describe('cfClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should export required functions', () => {
    expect(typeof cfClient.runCfCommand).toBe('function');
    expect(typeof cfClient.fetchRemoteCdsServicesFromTarget).toBe('function');
    expect(typeof cfClient.fetchXsuaaTokenFromTarget).toBe('function');
  });

  describe('runCfCommand', () => {
    it('should resolve on exit code 0', async () => {
      const mockChild = createMockChild();
      vi.mocked(spawn).mockReturnValue(mockChild);
      const promise = cfClient.runCfCommand(['test']);

      mockChild.stdout.write('success output');
      mockChild.emit('close', 0);

      const result = await promise;
      expect(result).toBe('success output');
    });

    it('should reject on non-zero exit code', async () => {
      const mockChild = createMockChild();
      vi.mocked(spawn).mockReturnValue(mockChild);
      const promise = cfClient.runCfCommand(['test']);

      mockChild.stderr.write('error output');
      mockChild.emit('close', 1);

      await expect(promise).rejects.toThrow(/error output/);
    });

    it('passes app names as literal arguments without invoking a shell', async () => {
      const mockChild = createMockChild();
      vi.mocked(spawn).mockReturnValue(mockChild);
      const appName = 'test-app; touch /tmp/injected';
      const promise = cfClient.runCfCommand(['env', appName]);

      mockChild.emit('close', 0);
      await promise;

      const call = vi.mocked(spawn).mock.calls[0];
      expect(call?.[0]).toBe('cf');
      expect(call?.[1]).toEqual(['env', appName]);
      expect(call?.[2]?.shell).toBe(false);
    });

    it('rejects output larger than the configured limit', async () => {
      const mockChild = createMockChild();
      vi.mocked(spawn).mockReturnValue(mockChild);
      const promise = cfClient.runCfCommand(['test'], { maxOutputBytes: 4 });

      mockChild.stdout.write('12345');
      mockChild.emit('close', 0);

      await expect(promise).rejects.toThrow('output exceeded 4 bytes');
    });

    it('terminates a CF command after the configured timeout', async () => {
      vi.useFakeTimers();
      const mockChild = createMockChild();
      const kill = vi.spyOn(mockChild, 'kill').mockReturnValue(true);
      vi.mocked(spawn).mockReturnValue(mockChild);
      const promise = cfClient.runCfCommand(['test'], { timeoutMs: 10 });
      const rejection = expect(promise).rejects.toThrow('timed out after 10ms');

      await vi.advanceTimersByTimeAsync(10);
      mockChild.emit('close', 0);

      await rejection;
      expect(kill).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });
  });

  describe('fetchRemoteCdsServicesFromTarget', () => {
    it('should return stdout if successful', async () => {
      const mockChild = createMockChild();
      vi.mocked(spawn).mockReturnValue(mockChild);
      const promise = cfClient.fetchRemoteCdsServicesFromTarget({ appName: 'test-app' });

      mockChild.stdout.write('service content');
      mockChild.emit('close', 0);

      const result = await promise;
      expect(result).toBe('service content');
    });

    it('passes the remote CDS scan as one unquoted cf ssh command argument', async () => {
      const mockChild = createMockChild();
      vi.mocked(spawn).mockReturnValue(mockChild);
      const promise = cfClient.fetchRemoteCdsServicesFromTarget({ appName: 'test-app' });

      mockChild.stdout.write('service content');
      mockChild.emit('close', 0);

      await promise;
      const call = vi.mocked(spawn).mock.calls[0];
      expect(call?.[0]).toBe('cf');
      expect(call?.[1]?.slice(0, 4)).toEqual(['ssh', 'test-app', '--disable-pseudo-tty', '-c']);
      const remoteCommand = call?.[1]?.[4];
      expect(remoteCommand).toContain("find / -maxdepth 7");
      expect(remoteCommand).toContain("-exec cat {} +");
      expect(remoteCommand?.startsWith('"')).toBe(false);
      expect(remoteCommand?.endsWith('"')).toBe(false);
    });

    it('should return null if SSH fails', async () => {
      const mockChild = createMockChild();
      vi.mocked(spawn).mockReturnValue(mockChild);
      const promise = cfClient.fetchRemoteCdsServicesFromTarget({ appName: 'test-app' });

      mockChild.stderr.write('error');
      mockChild.emit('close', 1);

      const result = await promise;
      expect(result).toBeNull();
    });
  });

  describe('fetchXsuaaTokenFromTarget', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      global.fetch = vi.fn();
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should return access token if CF env and fetch succeed', async () => {
      const mockChild = createMockChild();
      vi.mocked(spawn).mockReturnValue(mockChild);
      const promise = cfClient.fetchXsuaaTokenFromTarget({ appName: 'test-app' });
      const vcapOutput = `System-Provided:\nVCAP_SERVICES: {\n "xsuaa": [{ "credentials": { "clientid": "id", "clientsecret": "secret", "url": "https://auth.com" } }]\n}\n\n`;
      mockChild.stdout.write(vcapOutput);
      mockChild.emit('close', 0);

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'fake-token' }),
      } as Response);

      const result = await promise;
      expect(result).toBe('fake-token');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://auth.com/oauth/token?grant_type=client_credentials',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('parses VCAP_SERVICES when VCAP_APPLICATION follows without a blank separator', async () => {
      const mockChild = createMockChild();
      vi.mocked(spawn).mockReturnValue(mockChild);
      const promise = cfClient.fetchXsuaaTokenFromTarget({ appName: 'test-app' });
      const vcapOutput = [
        'System-Provided:',
        'VCAP_SERVICES: {"xsuaa":[{"credentials":{"clientid":"id","clientsecret":"secret","url":"https://auth.com"}}]}',
        'VCAP_APPLICATION: {"application_name":"test-app"}',
        'User-Provided:',
        '(empty)',
      ].join('\n');
      mockChild.stdout.write(vcapOutput);
      mockChild.emit('close', 0);

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'fake-token' }),
      } as Response);

      await expect(promise).resolves.toBe('fake-token');
    });

    it('parses VCAP_SERVICES from structured System-Provided JSON', async () => {
      const mockChild = createMockChild();
      vi.mocked(spawn).mockReturnValue(mockChild);
      const promise = cfClient.fetchXsuaaTokenFromTarget({ appName: 'test-app' });
      const vcapOutput = [
        'System-Provided:',
        JSON.stringify({
          VCAP_SERVICES: {
            xsuaa: [
              {
                credentials: {
                  clientid: 'id',
                  clientsecret: 'secret',
                  url: 'https://auth.com',
                },
              },
            ],
          },
        }),
        '',
      ].join('\n');
      mockChild.stdout.write(vcapOutput);
      mockChild.emit('close', 0);

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'fake-token' }),
      } as Response);

      await expect(promise).resolves.toBe('fake-token');
    });

    it('does not request a token when xsuaa credentials are incomplete', async () => {
      const mockChild = createMockChild();
      vi.mocked(spawn).mockReturnValue(mockChild);
      const promise = cfClient.fetchXsuaaTokenFromTarget({ appName: 'test-app' });
      const vcapOutput = 'VCAP_SERVICES: {"xsuaa":[{"credentials":{"clientid":"id","url":"https://auth.com"}}]}';
      mockChild.stdout.write(vcapOutput);
      mockChild.emit('close', 0);

      await expect(promise).resolves.toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns null when the token endpoint does not return an access token string', async () => {
      const mockChild = createMockChild();
      vi.mocked(spawn).mockReturnValue(mockChild);
      const promise = cfClient.fetchXsuaaTokenFromTarget({ appName: 'test-app' });
      const vcapOutput = 'VCAP_SERVICES: {"xsuaa":[{"credentials":{"clientid":"id","clientsecret":"secret","url":"https://auth.com"}}]}';
      mockChild.stdout.write(vcapOutput);
      mockChild.emit('close', 0);

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 123 }),
      } as Response);

      await expect(promise).resolves.toBeNull();
    });

    it('should return null if CF env fails', async () => {
      const mockChild = createMockChild();
      vi.mocked(spawn).mockReturnValue(mockChild);
      const promise = cfClient.fetchXsuaaTokenFromTarget({ appName: 'test-app' });
      mockChild.emit('close', 1);

      const result = await promise;
      expect(result).toBeNull();
    });
  });
});
