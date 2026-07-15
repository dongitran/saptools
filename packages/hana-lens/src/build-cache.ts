import { cachePath, writeCache } from "./cache.js";
import { compilePackages } from "./compiler.js";
import { autoLinkPackages, normalizePackagePrefix, scanForPackages } from "./packages.js";
import { applyCacheKindFilter, parseCacheKind } from "./scope.js";
import type { CacheKind } from "./scope.js";
import type { CompileResult, HanaLensCsn, PackageSkip, SapPackage } from "./types.js";

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
  readonly cacheFile: string;
}

export async function buildCache(
  workspaceDirectory: string,
  prefix: string,
  options: BuildCacheOptions = {},
): Promise<BuildCacheResult> {
  const kind = parseCacheKind(options.kind);
  const normalizedPrefix = normalizePackagePrefix(prefix);
  const packages = await scanForPackages(workspaceDirectory, normalizedPrefix);
  if (packages.length === 0) {
    throw new Error(`No packages starting with ${normalizedPrefix} found in ${workspaceDirectory}`);
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
    cacheFile: cachePath(workspaceDirectory),
  };
}
