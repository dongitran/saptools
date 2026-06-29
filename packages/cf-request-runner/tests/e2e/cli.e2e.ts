import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from '@playwright/test';

const currentFilename = fileURLToPath(import.meta.url);
const currentDirname = path.dirname(currentFilename);
const cliPath = path.resolve(currentDirname, '../../dist/cli.js');

test.describe('cf-request-runner CLI e2e', () => {
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
});
