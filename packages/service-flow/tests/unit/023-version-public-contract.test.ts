import packageJson from '../../package.json' with { type: 'json' };
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  compactTrace,
  traceAndCompact,
} from '../../src/index.js';
import type {
  CompactEdgeRowV1,
  CompactGraphV1,
  CompactNodeRowV1,
  CompactStatus,
  CompactTraceExecution,
} from '../../src/index.js';
import { ANALYZER_VERSION, VERSION } from '../../src/version.js';

type PublicCompactContract = [
  CompactGraphV1,
  CompactTraceExecution,
  CompactNodeRowV1,
  CompactEdgeRowV1,
  CompactStatus,
];

describe('package, analyzer, and public compact contracts', () => {
  it('keeps package/CLI version authority separate from fact compatibility', async () => {
    expect(VERSION).toBe(packageJson.version);
    expect(VERSION).toBe('0.1.67');
    expect(ANALYZER_VERSION).toBe('0.1.66-facts.1');
    expect(ANALYZER_VERSION).not.toBe(VERSION);
    const source = await readFile(
      new URL('../../src/version.ts', import.meta.url), 'utf8',
    );
    expect(source).toContain('export const VERSION = packageJson.version;');
    expect(source).toContain(
      "export const ANALYZER_VERSION = '0.1.66-facts.1';",
    );
    expect(source).not.toMatch(/ANALYZER_VERSION\s*=\s*VERSION/);
  });

  it('exports the one-pass compact entry points and v1 consumer types', () => {
    const publicTypeWidth: PublicCompactContract['length'] = 5;
    expect(publicTypeWidth).toBe(5);
    expect(compactTrace).toBeTypeOf('function');
    expect(traceAndCompact).toBeTypeOf('function');
  });
});
