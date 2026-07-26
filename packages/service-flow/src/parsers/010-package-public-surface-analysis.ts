import { posix } from 'node:path';
import {
  moduleInfoMap,
  PACKAGE_PUBLIC_SURFACE_RECORD_CAP,
  PACKAGE_PUBLIC_SURFACE_SCHEMA,
  resolveModule,
} from './003-package-public-surface.js';
import type {
  ModuleInfo,
  ModuleResolution,
  PackagePublicEntry,
  PackagePublicScope,
  PackagePublicSurfaceAnalysis,
  PackagePublicSurfaceFact,
  PackagePublicSurfaceStatus,
  PackageSourceModule,
  ResolvedExport,
  SymbolPublicSurfaceEvidence,
} from './003-package-public-surface.js';
import type { PackageEntrypointManifest } from './package-json-parser.js';

interface EntryResolution {
  entries: PackagePublicEntry[];
  status: 'complete' | 'incomplete' | 'unsupported';
  reason?: string;
}

interface RetainedSurface {
  entries: PackagePublicEntry[];
  scopes: PackagePublicScope[];
  total: number;
  shown: number;
}

function compareBinary(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function targetKey(target: SymbolPublicSurfaceEvidence['target']): string {
  return [
    target.sourceFile, target.startOffset, target.endOffset,
    target.kind, target.qualifiedName,
  ].join('\0');
}

function canonicalModulePath(sourceFile: string): string {
  return sourceFile.replace(/\\/g, '/').replace(/\.(?:d\.)?(?:ts|js)$/, '');
}

function validEntry(entry: string): boolean {
  return entry === '.' || (
    entry.startsWith('./') && !entry.includes('*')
    && !entry.split('/').some((part) => part === '..')
  );
}

function entryModuleCandidates(
  specifier: string,
  infos: Map<string, ModuleInfo[]>,
): string[] {
  if (!specifier.startsWith('./') || specifier.includes('*')) return [];
  const normalized = posix.normalize(specifier.slice(2));
  if (!normalized || normalized === '..' || normalized.startsWith('../'))
    return [];
  const base = canonicalModulePath(normalized);
  const hasExtension = /\.(?:d\.)?(?:ts|js)$/.test(normalized);
  const candidates = hasExtension ? [base] : [base, `${base}/index`];
  return candidates.filter((item, index, values) => {
    const rows = infos.get(item) ?? [];
    return values.indexOf(item) === index && rows.length === 1
      && (!hasExtension || rows[0]?.sourceFile === normalized);
  });
}

function resolveEntry(
  entry: string,
  target: string,
  infos: Map<string, ModuleInfo[]>,
): PackagePublicEntry | undefined {
  const candidates = entryModuleCandidates(target, infos);
  return candidates.length === 1 && candidates[0]
    ? { entry, modulePath: candidates[0] }
    : undefined;
}

function resolvedEntryPairs(
  pairs: Array<[string, string]>,
  infos: Map<string, ModuleInfo[]>,
): EntryResolution {
  const entries: PackagePublicEntry[] = [];
  pairs.sort((left, right) => compareBinary(left[0], right[0]));
  for (const [entry, target] of pairs) {
    const resolved = resolveEntry(entry, target, infos);
    if (!resolved) return {
      entries: [], status: 'incomplete',
      reason: 'public_surface_entry_target_not_indexed',
    };
    entries.push(resolved);
  }
  return { entries, status: 'complete' };
}

function explicitExportEntries(
  manifest: PackageEntrypointManifest,
  infos: Map<string, ModuleInfo[]>,
): EntryResolution {
  const value = manifest.exportsValue;
  const pairs: Array<[string, string]> = [];
  if (typeof value === 'string') pairs.push(['.', value]);
  else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [entry, target] of Object.entries(value)) {
      if (!validEntry(entry) || typeof target !== 'string'
        || target.includes('*')) return {
        entries: [], status: 'unsupported',
        reason: 'unsupported_exports_map_shape',
      };
      pairs.push([entry, target]);
    }
  } else return {
    entries: [], status: 'unsupported',
    reason: 'unsupported_exports_map_shape',
  };
  return resolvedEntryPairs(pairs, infos);
}

function hasUnsupportedLegacyEntrypoint(
  manifest: PackageEntrypointManifest,
): boolean {
  return (manifest.mainPresent && !manifest.main)
    || (manifest.modulePresent && !manifest.module);
}

function legacyRootEntry(
  manifest: PackageEntrypointManifest,
  infos: Map<string, ModuleInfo[]>,
): EntryResolution {
  if (hasUnsupportedLegacyEntrypoint(manifest)) return {
    entries: [], status: 'unsupported',
    reason: 'unsupported_package_entrypoint_shape',
  };
  const targets = [manifest.module, manifest.main]
    .filter((value): value is string => typeof value === 'string');
  if (targets.length === 0) return (infos.get('index') ?? []).length === 1
    ? { entries: [{ entry: '.', modulePath: 'index' }], status: 'complete' }
    : { entries: [], status: 'complete' };
  const resolved = targets.map((target) => resolveEntry('.', target, infos));
  const paths = new Set(resolved.flatMap((item) =>
    item ? [item.modulePath] : []));
  if (resolved.some((item) => !item) || paths.size !== 1) return {
    entries: [], status: 'incomplete',
    reason: paths.size > 1
      ? 'public_surface_main_module_conflict'
      : 'public_surface_entry_target_not_indexed',
  };
  const [modulePath] = paths;
  return modulePath
    ? { entries: [{ entry: '.', modulePath }], status: 'complete' }
    : { entries: [], status: 'complete' };
}

function legacyPhysicalEntries(
  infos: Map<string, ModuleInfo[]>,
): PackagePublicEntry[] {
  const byEntry = new Map<string, Set<string>>();
  for (const [modulePath, rows] of infos) {
    if (rows.length !== 1) continue;
    const entries = [`./${modulePath}`];
    if (modulePath.endsWith('/index'))
      entries.push(`./${modulePath.slice(0, -'/index'.length)}`);
    for (const entry of entries) {
      const paths = byEntry.get(entry) ?? new Set<string>();
      paths.add(modulePath);
      byEntry.set(entry, paths);
    }
  }
  return [...byEntry.entries()].flatMap(([entry, paths]) =>
    paths.size === 1 ? [{ entry, modulePath: [...paths][0] ?? '' }] : [])
    .filter((item) => item.modulePath)
    .sort((left, right) => compareBinary(left.entry, right.entry));
}

function entryResolution(
  manifest: PackageEntrypointManifest,
  infos: Map<string, ModuleInfo[]>,
): EntryResolution {
  if (manifest.exportsPresent) return explicitExportEntries(manifest, infos);
  const root = legacyRootEntry(manifest, infos);
  if (root.status !== 'complete') return root;
  const byEntry = new Map(
    [...root.entries, ...legacyPhysicalEntries(infos)]
      .map((item) => [item.entry, item]),
  );
  return {
    entries: [...byEntry.values()].sort((left, right) =>
      compareBinary(left.entry, right.entry)),
    status: 'complete',
  };
}

function scopeFromExport(
  entry: PackagePublicEntry,
  publicName: string,
  value: ResolvedExport,
): PackagePublicScope {
  const eligible = value.targets.filter((item) =>
    item.bodyEligibility.eligible);
  const candidateCount = value.targets.length + value.declarationOnlyCount;
  return {
    ...entry, publicName, candidateCount,
    eligibleCandidateCount: eligible.length,
    selectedCandidateCount: eligible.length === 1 ? 1 : 0,
    candidateSetComplete: true, targets: value.targets,
  };
}

function allScopes(
  entries: readonly PackagePublicEntry[],
  infos: Map<string, ModuleInfo[]>,
): { scopes: PackagePublicScope[]; reason?: string } {
  const memo = new Map<string, ModuleResolution>();
  const scopes: PackagePublicScope[] = [];
  for (const entry of entries) {
    const resolved = resolveModule(entry.modulePath, infos, memo);
    if (!resolved.complete) return { scopes: [], reason: resolved.reason };
    for (const [publicName, value] of resolved.exports)
      scopes.push(scopeFromExport(entry, publicName, value));
  }
  scopes.sort((left, right) => compareBinary(
    `${left.entry}\0${left.publicName}`,
    `${right.entry}\0${right.publicName}`,
  ));
  return { scopes };
}

function retainSurface(
  entries: readonly PackagePublicEntry[],
  scopes: readonly PackagePublicScope[],
): RetainedSurface {
  let remaining = PACKAGE_PUBLIC_SURFACE_RECORD_CAP;
  const retainedEntries = entries.slice(0, remaining);
  remaining -= retainedEntries.length;
  const entryNames = new Set(retainedEntries.map((item) => item.entry));
  const retainedScopes: PackagePublicScope[] = [];
  for (const scope of scopes) {
    const cost = 1 + scope.targets.length;
    if (!entryNames.has(scope.entry) || cost > remaining) continue;
    retainedScopes.push(scope);
    remaining -= cost;
  }
  const total = entries.length + scopes.reduce(
    (sum, scope) => sum + 1 + scope.targets.length, 0,
  );
  return {
    entries: retainedEntries, scopes: retainedScopes, total,
    shown: PACKAGE_PUBLIC_SURFACE_RECORD_CAP - remaining,
  };
}

function symbolEvidence(
  scopes: readonly PackagePublicScope[],
): SymbolPublicSurfaceEvidence[] {
  const result = new Map<string, SymbolPublicSurfaceEvidence>();
  for (const scope of scopes) for (const target of scope.targets) {
    const key = targetKey(target);
    const current = result.get(key) ?? {
      target,
      exposures: [],
      exposureTotal: 0,
      shownExposureCount: 0,
      omittedExposureCount: 0,
    };
    current.exposures.push({
      entry: scope.entry, modulePath: scope.modulePath,
      publicName: scope.publicName,
    });
    result.set(key, current);
  }
  return [...result.values()].map((item) => {
    const exposures = item.exposures.sort((left, right) => compareBinary(
      `${left.entry}\0${left.publicName}`,
      `${right.entry}\0${right.publicName}`,
    ));
    return {
      ...item,
      exposures,
      exposureTotal: exposures.length,
      shownExposureCount: exposures.length,
      omittedExposureCount: 0,
    };
  }).sort((left, right) =>
    compareBinary(targetKey(left.target), targetKey(right.target)));
}

function baseSurface(
  packageName: string | undefined,
  manifest: PackageEntrypointManifest,
  status: PackagePublicSurfaceStatus,
  reason: string | null,
): PackagePublicSurfaceFact {
  return {
    schema: PACKAGE_PUBLIC_SURFACE_SCHEMA, status, reason,
    recordCap: PACKAGE_PUBLIC_SURFACE_RECORD_CAP,
    total: 0, shown: 0, omitted: 0, packageName: packageName ?? null,
    exportsPresent: manifest.exportsPresent,
    exportsAuthoritative: manifest.exportsPresent,
    main: manifest.main, module: manifest.module, entries: [], scopes: [],
  };
}

function moduleFailureStatus(
  reason: string,
): Extract<PackagePublicSurfaceStatus, 'incomplete' | 'unsupported'> {
  return reason.startsWith('unsupported_')
    || reason === 'anonymous_default_export_without_symbol_identity'
    ? 'unsupported'
    : 'incomplete';
}

export function analyzePackagePublicSurface(
  packageName: string | undefined,
  manifest: PackageEntrypointManifest,
  modules: readonly PackageSourceModule[],
): PackagePublicSurfaceAnalysis {
  if (!packageName) return {
    surface: baseSurface(packageName, manifest, 'not_applicable', null),
    symbols: [],
  };
  const infos = moduleInfoMap(modules);
  const entries = entryResolution(manifest, infos);
  if (entries.status !== 'complete') return {
    surface: baseSurface(
      packageName, manifest, entries.status, entries.reason ?? null,
    ),
    symbols: [],
  };
  const resolved = allScopes(entries.entries, infos);
  if (resolved.reason) return {
    surface: baseSurface(
      packageName, manifest,
      moduleFailureStatus(resolved.reason), resolved.reason,
    ),
    symbols: [],
  };
  const retained = retainSurface(entries.entries, resolved.scopes);
  const surface = baseSurface(packageName, manifest, 'complete', null);
  Object.assign(surface, {
    entries: retained.entries, scopes: retained.scopes,
    total: retained.total, shown: retained.shown,
    omitted: Math.max(0, retained.total - retained.shown),
  });
  return { surface, symbols: symbolEvidence(retained.scopes) };
}
