import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { test, expect } from '@playwright/test';

const currentFilename = fileURLToPath(import.meta.url);
const currentDirname = path.dirname(currentFilename);
const cliPath = path.resolve(currentDirname, '../../dist/cli.js');
const packageJsonPath = path.resolve(currentDirname, '../../package.json');
const execFileAsync = promisify(execFile);

function readPackageVersion(): string {
  const raw = readFileSync(packageJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as { readonly version?: unknown };
  if (typeof parsed.version !== 'string') {
    throw new Error('Package version is missing');
  }
  return parsed.version;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}



async function runInteractiveCli(args: readonly string[]): Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number | null }> {
  const child = spawn(process.execPath, [cliPath, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let answeredEndpoint = false;
  let answeredMethod = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (!answeredEndpoint && stdout.includes('Select an endpoint')) {
      answeredEndpoint = true;
      child.stdin.write('1\n');
      return;
    }
    if (!answeredMethod && stdout.includes('Select HTTP method')) {
      answeredMethod = true;
      child.stdin.end('1\n');
    }
  });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { stdout, stderr, code };
}

function getServerUrl(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Server address is unavailable');
  }
  const { port } = address;
  return `http://127.0.0.1:${port.toString()}`;
}

test.describe('cf-request-runner CLI e2e', () => {
  test('User can see the package version', () => {
    const output = execFileSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' });
    expect(output.trim()).toBe(readPackageVersion());
  });

  test('User can see required options when no arguments are provided', () => {
    try {
      execFileSync(process.execPath, [cliPath]);
      throw new Error('Command should have failed without arguments');
    } catch (error: unknown) {
      if (error instanceof Error && 'status' in error && 'stderr' in error) {
        expect((error as { status: number }).status).not.toBe(0);
        expect((error as { stderr: Buffer }).stderr.toString()).toContain('error: required option');
      } else {
        throw error;
      }
    }
  });

  test('User can see which required option is missing', () => {
    try {
      execFileSync(process.execPath, [cliPath, '-a', 'my-app']);
      throw new Error('Command should have failed without url');
    } catch (error: unknown) {
      if (error instanceof Error && 'status' in error && 'stderr' in error) {
        expect((error as { status: number }).status).not.toBe(0);
        expect((error as { stderr: Buffer }).stderr.toString()).toContain('error: required option \'-u, --url <baseUrl>\' not specified');
      } else {
        throw error;
      }
    }
  });

  test('User can provide the bearer token through the environment', async () => {
    const authorizations: string[] = [];
    const server = createServer((request, response) => {
      authorizations.push(request.headers.authorization ?? '');
      if (request.url === '/') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ endpoints: [{ name: 'CatalogService', path: '/odata/v4/catalog' }] }));
        return;
      }
      if (request.url === '/odata/v4/catalog/$metadata') {
        response.setHeader('Content-Type', 'application/xml');
        response.end('<EntityContainer><EntitySet Name="Books" EntityType="CatalogService.Books" /></EntityContainer>');
        return;
      }
      response.statusCode = 404;
      response.end('not found');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const result = await execFileAsync(
        process.execPath,
        [cliPath, '-a', 'my-app', '-u', getServerUrl(server), '--json'],
        {
          encoding: 'utf8',
          env: { ...process.env, CF_REQUEST_RUNNER_TOKEN: 'env-token' },
        },
      );

      expect(JSON.parse(result.stdout)).toEqual([
        {
          name: 'CatalogService / Books',
          path: '/odata/v4/catalog/Books',
          methods: ['GET', 'POST', 'PATCH', 'DELETE'],
          schema: { type: 'object', properties: {} },
        },
      ]);
      expect(authorizations).toEqual(['Bearer env-token', 'Bearer env-token']);
    } finally {
      await closeServer(server);
    }
  });

  test('User can save JSON output to a missing nested directory', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cf-request-runner-'));
    const outPath = path.join(tempDir, 'reports', 'endpoints.json');
    const server = createServer((request, response) => {
      if (request.url === '/') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ endpoints: [{ name: 'CatalogService', path: '/odata/v4/catalog' }] }));
        return;
      }
      response.statusCode = 404;
      response.end('not found');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const result = await execFileAsync(
        process.execPath,
        [cliPath, '-a', 'my-app', '-u', getServerUrl(server), '--token', 'test-token', '--out', outPath],
        { encoding: 'utf8' },
      );

      expect(result.stdout).toContain('Successfully saved 1 endpoints');
      expect(JSON.parse(readFileSync(outPath, 'utf8'))).toEqual([
        {
          name: 'CatalogService',
          path: '/odata/v4/catalog',
          methods: ['GET', 'POST', 'PATCH', 'DELETE'],
          schema: { type: 'object', properties: {} },
        },
      ]);
    } finally {
      await closeServer(server);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('User can copy curl commands with the resolved bearer token', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ endpoints: [{ name: 'CatalogService', path: '/odata/v4/catalog' }] }));
        return;
      }
      if (request.url === '/odata/v4/catalog/$metadata') {
        response.setHeader('Content-Type', 'application/xml');
        response.end('<EntityContainer><EntitySet Name="Books" EntityType="CatalogService.Books" /></EntityContainer>');
        return;
      }
      response.statusCode = 404;
      response.end('not found');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const result = await execFileAsync(
        process.execPath,
        [cliPath, '-a', 'my-app', '-u', getServerUrl(server), '--token', 'copy-token', '--curl'],
        { encoding: 'utf8' },
      );

      expect(result.stdout).toContain("curl --fail-with-body --show-error -X 'GET'");
      expect(result.stdout).toContain("-H 'Authorization: Bearer copy-token'");
      expect(result.stdout).toContain('/odata/v4/catalog/Books');
    } finally {
      await closeServer(server);
    }
  });




  test('User can execute a discovered endpoint interactively', async () => {
    const requests: { readonly url: string | undefined; readonly method: string | undefined; readonly authorization: string | undefined }[] = [];
    const server = createServer((request, response) => {
      requests.push({ url: request.url, method: request.method, authorization: request.headers.authorization });
      if (request.url === '/') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ endpoints: [{ name: 'CatalogService', path: '/odata/v4/catalog' }] }));
        return;
      }
      if (request.url === '/odata/v4/catalog/$metadata') {
        response.setHeader('Content-Type', 'application/xml');
        response.end('<EntityContainer><EntitySet Name="Books" EntityType="CatalogService.Books" /></EntityContainer>');
        return;
      }
      if (request.url === '/odata/v4/catalog/Books') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ value: [{ ID: 1 }] }));
        return;
      }
      response.statusCode = 404;
      response.end('not found');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const result = await runInteractiveCli([
        '-a', 'my-app',
        '-u', getServerUrl(server),
        '--token', 'interactive-token',
        '--interactive',
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Select an endpoint for my-app');
      expect(result.stdout).toContain('Select HTTP method');
      expect(result.stdout).toContain('200 OK');
      expect(result.stdout).toContain('"ID"');
      expect(requests.at(-1)).toEqual({
        url: '/odata/v4/catalog/Books',
        method: 'GET',
        authorization: 'Bearer interactive-token',
      });
    } finally {
      await closeServer(server);
    }
  });

});
