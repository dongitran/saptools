import { cachePath, writeCache } from "./cache.js";
import { compilePackages } from "./compiler.js";
import { autoLinkPackages, normalizePackagePrefix, scanForPackages } from "./packages.js";
import { applyCacheKindFilter, parseCacheKind } from "./scope.js";
import type { CacheKind } from "./scope.js";
import type { CompileResult, HanaLensCsn, PackageScanWarning, PackageSkip, SapPackage } from "./types.js";

const FAILURE_REASON_LIMIT = 2_000;

export interface BuildCacheOptions {
  readonly allowFallback?: boolean;
  readonly strict?: boolean;
  readonly kind?: CacheKind;
}

export interface BuildCacheResult {
  readonly ast: HanaLensCsn;
  readonly packages: readonly SapPackage[];
  readonly compiled: readonly CompileResult[];
  readonly skipped: readonly PackageSkip[];
  readonly scanWarnings: readonly PackageScanWarning[];
  readonly excludedPackages: readonly PackageScanWarning[];
  readonly cacheFile: string;
}

export async function buildCache(
  workspaceDirectory: string,
  prefix: string,
  options: BuildCacheOptions = {},
): Promise<BuildCacheResult> {
  const kind = parseCacheKind(options.kind);
  const normalizedPrefix = normalizePackagePrefix(prefix);
  const { packages, warnings: scanWarnings, excluded: excludedPackages } = await scanForPackages(workspaceDirectory, normalizedPrefix);
  if (packages.length === 0) {
    throw new Error(`No packages starting with ${normalizedPrefix} found in ${workspaceDirectory}`);
  }
  if (options.strict === true && excludedPackages.length > 0) {
    const names = excludedPackages.map((exclusion) => exclusion.directory).join(", ");
    throw new Error(`Strict mode: ${excludedPackages.length.toString()} package(s) excluded by a fallback name collision: ${names}`);
  }
  await autoLinkPackages(packages, normalizedPrefix);
  const outcome = await compilePackages(
    packages,
    options.allowFallback ?? false,
    options.strict ?? false,
  );
  if (outcome.compiled.length === 0) {
    const firstFailure = outcome.skipped[0]?.reason;
    const boundedFailure = firstFailure !== undefined && firstFailure.length > FAILURE_REASON_LIMIT
      ? `${firstFailure.slice(0, FAILURE_REASON_LIMIT)}...`
      : firstFailure;
    const detail = boundedFailure === undefined ? "" : ` First failure: ${boundedFailure}`;
    throw new Error(`No packages compiled successfully in ${workspaceDirectory}.${detail}`);
  }
  const scopedResults = applyCacheKindFilter(outcome.compiled, kind);
  const ast = await writeCache(workspaceDirectory, scopedResults, options.strict ?? false);
  return {
    ast,
    packages,
    compiled: outcome.compiled,
    skipped: outcome.skipped,
    scanWarnings,
    excludedPackages,
    cacheFile: cachePath(workspaceDirectory),
  };
}
