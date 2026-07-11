import fs from 'node:fs/promises';
import path from 'node:path';
import type { CdsRequire, PackageFacts } from '../types.js';
interface ParsePackageJsonOptions {
  strict?: boolean;
  allowMissing?: boolean;
}
export interface PackageJsonSnapshot {
  facts: PackageFacts;
  rawText: string;
}
function emptyPackageFacts(): PackageFacts {
  return { dependencies: {}, cdsRequires: [], scripts: {} };
}
function recordOfString(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => typeof v === 'string')
  ) as Record<string, string>;
}
function readRequires(cds: unknown): CdsRequire[] {
  const requires =
    cds && typeof cds === 'object' && 'requires' in cds
      ? (cds as { requires?: unknown }).requires
      : undefined;
  if (!requires || typeof requires !== 'object') return [];
  return Object.entries(requires).flatMap(([alias, raw]) => {
    if (!raw || typeof raw !== 'object') return [];
    const obj = raw as Record<string, unknown>;
    const credentials =
      obj.credentials && typeof obj.credentials === 'object'
        ? (obj.credentials as Record<string, unknown>)
        : {};
    return [
      {
        alias,
        kind: typeof obj.kind === 'string' ? obj.kind : undefined,
        model: typeof obj.model === 'string' ? obj.model : undefined,
        destination:
          typeof credentials.destination === 'string'
            ? credentials.destination
            : undefined,
        servicePath:
          typeof credentials.path === 'string' ? credentials.path : undefined,
        requestTimeout:
          typeof credentials.requestTimeout === 'number'
            ? credentials.requestTimeout
            : undefined,
        rawJson: JSON.stringify(raw)
      }
    ];
  });
}
export async function parsePackageJson(
  repoPath: string,
  options: ParsePackageJsonOptions = {},
): Promise<PackageFacts> {
  return (await loadPackageJsonSnapshot(repoPath, options)).facts;
}
export async function loadPackageJsonSnapshot(
  repoPath: string,
  options: ParsePackageJsonOptions = {},
): Promise<PackageJsonSnapshot> {
  try {
    const raw = await fs.readFile(path.join(repoPath, 'package.json'), 'utf8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    return {
      rawText: raw,
      facts: {
        packageName: typeof json.name === 'string' ? json.name : undefined,
        packageVersion:
          typeof json.version === 'string' ? json.version : undefined,
        dependencies: {
          ...recordOfString(json.dependencies),
          ...recordOfString(json.devDependencies),
        },
        cdsRequires: readRequires(json.cds),
        scripts: recordOfString(json.scripts),
      },
    };
  } catch (error) {
    const missing = typeof error === 'object' && error !== null
      && 'code' in error && error.code === 'ENOENT';
    if (!options.strict || (options.allowMissing && missing))
      return { facts: emptyPackageFacts(), rawText: '' };
    throw error;
  }
}
