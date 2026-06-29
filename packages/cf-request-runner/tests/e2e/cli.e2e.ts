import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
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
});
