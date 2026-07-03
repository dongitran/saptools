import { cachePath, writeCache } from "./cache.js";
import { compilePackages } from "./compiler.js";
import { autoLinkPackages, normalizePackagePrefix, scanForPackages } from "./packages.js";
import type { HanaLensCsn, SapPackage } from "./types.js";

export interface BuildCacheResult {
  readonly ast: HanaLensCsn;
  readonly packages: readonly SapPackage[];
  readonly cacheFile: string;
}

export async function buildCache(workspaceDirectory: string, prefix: string): Promise<BuildCacheResult> {
  const normalizedPrefix = normalizePackagePrefix(prefix);
  const packages = await scanForPackages(workspaceDirectory, normalizedPrefix);
  if (packages.length === 0) {
    throw new Error(`No packages starting with ${normalizedPrefix} found in ${workspaceDirectory}`);
  }
  await autoLinkPackages(packages, normalizedPrefix);
  const results = await compilePackages(packages);
  const ast = await writeCache(workspaceDirectory, results);
  return { ast, packages, cacheFile: cachePath(workspaceDirectory) };
}
