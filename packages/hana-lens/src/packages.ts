import type { Dirent } from "node:fs";
import { lstat, mkdir, readlink, readdir, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";

import { levenshtein } from "./levenshtein.js";
import type { PackageScanWarning, SapPackage } from "./types.js";
import { isRecord } from "./validation.js";

const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "gen"]);

interface ResolvedPackageCandidate extends SapPackage {
  readonly keptDeclaredName: boolean;
}

export function normalizePackagePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (trimmed.length === 0) {
    throw new Error("--prefix must not be empty");
  }
  if (!trimmed.startsWith("@")) {
    throw new Error("--prefix must be a scoped package prefix such as @org/");
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex !== -1 && slashIndex !== trimmed.length - 1) {
    throw new Error("--prefix must be a package scope such as @org/");
  }
  const scope = slashIndex === -1 ? trimmed : trimmed.slice(0, -1);
  if (scope.length <= 1) {
    throw new Error("--prefix must be a scoped package prefix such as @org/");
  }
  return `${scope}/`;
}

export function packageScope(prefix: string): string {
  const normalized = normalizePackagePrefix(prefix);
  const scope = normalized.slice(0, normalized.indexOf("/"));
  if (scope.length === 0) {
    throw new Error("--prefix must include a package scope");
  }
  return scope;
}

function packageShortName(packageName: string, prefix: string): string {
  const normalizedPrefix = normalizePackagePrefix(prefix);
  if (!packageName.startsWith(normalizedPrefix)) {
    throw new Error(`Package ${packageName} does not start with ${normalizedPrefix}`);
  }
  const shortName = packageName.slice(normalizedPrefix.length);
  if (shortName.length === 0 || shortName.includes("/")) {
    throw new Error(`Package ${packageName} is not a direct child of ${normalizedPrefix}`);
  }
  return shortName;
}

async function readPackageName(packageJsonPath: string): Promise<string | undefined> {
  const raw = await readFile(packageJsonPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || typeof parsed["name"] !== "string") {
    return undefined;
  }
  return parsed["name"];
}

function normalizeComparisonName(value: string): string {
  return value.toLowerCase().replace(/[-_]+/gu, "_");
}

function folderMatchDistance(directory: string, declaredShortName: string, scopeBareName: string): number {
  const normalizedShortName = normalizeComparisonName(declaredShortName);
  const normalizedBasename = normalizeComparisonName(path.basename(directory));
  const scopeToken = `${normalizeComparisonName(scopeBareName)}_`;
  const basenameWithoutScope = normalizedBasename.startsWith(scopeToken)
    ? normalizedBasename.slice(scopeToken.length)
    : normalizedBasename;
  return Math.min(
    levenshtein(normalizedShortName, normalizedBasename),
    levenshtein(normalizedShortName, basenameWithoutScope),
  );
}

function folderDerivedPackageName(directory: string, scope: string, scopeBareName: string): string {
  const basename = path.basename(directory);
  const lowercaseBasename = basename.toLowerCase();
  const lowercaseScope = scopeBareName.toLowerCase();
  const scopeToken = [`${lowercaseScope}_`, `${lowercaseScope}-`]
    .find((token) => lowercaseBasename.startsWith(token));
  const strippedBasename = scopeToken === undefined ? basename : basename.slice(scopeToken.length);
  const shortName = strippedBasename.length === 0 ? basename : strippedBasename;
  return `${scope}/${shortName}`;
}

function resolveDeclaredNameCollisions(found: ReadonlyMap<string, readonly string[]>, normalizedPrefix: string): readonly ResolvedPackageCandidate[] {
  const scope = packageScope(normalizedPrefix);
  const scopeBareName = scope.slice(1);
  const candidates: ResolvedPackageCandidate[] = [];
  const groups = [...found.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [name, directories] of groups) {
    const declaredShortName = name.slice(normalizedPrefix.length);
    const ranked = directories.map((directory) => ({
      directory,
      distance: folderMatchDistance(directory, declaredShortName, scopeBareName),
    })).sort((left, right) => left.distance - right.distance || left.directory.localeCompare(right.directory));
    const [winner, ...losers] = ranked;
    if (winner === undefined) {
      continue;
    }
    candidates.push({ name, directory: winner.directory, keptDeclaredName: true });
    for (const loser of losers) {
      const fallbackName = folderDerivedPackageName(loser.directory, scope, scopeBareName);
      candidates.push({ name: fallbackName, directory: loser.directory, keptDeclaredName: false });
      process.stderr.write(`Warning: Duplicate package name ${JSON.stringify(name)} kept ${JSON.stringify(winner.directory)}; renamed ${JSON.stringify(loser.directory)} to fallback ${JSON.stringify(fallbackName)}.\n`);
    }
  }
  return candidates;
}

interface FallbackCollisionResult {
  readonly packages: readonly SapPackage[];
  readonly excluded: readonly PackageScanWarning[];
}

function excludeFallbackNameCollisions(candidates: readonly ResolvedPackageCandidate[]): FallbackCollisionResult {
  const grouped = new Map<string, readonly ResolvedPackageCandidate[]>();
  for (const candidate of candidates) {
    grouped.set(candidate.name, [...(grouped.get(candidate.name) ?? []), candidate]);
  }
  const survivors: ResolvedPackageCandidate[] = [];
  const excludedWarnings: PackageScanWarning[] = [];
  const groups = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [name, group] of groups) {
    if (group.length === 1) {
      survivors.push(...group);
      continue;
    }
    const sortedByDirectory = [...group].sort((left, right) => left.directory.localeCompare(right.directory));
    // Two different collision groups can each independently derive the same fallback name, so
    // neither member here may have kept its declared name -- pick a deterministic survivor
    // instead of dropping the whole group, which previously lost every package in it.
    const original = group.find((candidate) => candidate.keptDeclaredName) ?? sortedByDirectory[0];
    const excluded = sortedByDirectory.filter((candidate) => candidate !== original);
    if (original !== undefined) {
      survivors.push(original);
    }
    for (const loser of excluded) {
      excludedWarnings.push({
        directory: loser.directory,
        reason: `Excluding fallback package name ${JSON.stringify(name)}; entities under this folder will be missing from the cache`,
      });
    }
    const directories = excluded.map((candidate) => JSON.stringify(candidate.directory)).join(", ");
    process.stderr.write(`Warning: Excluding fallback package name ${JSON.stringify(name)} from ${directories}; entities under these folders will be missing from the cache.\n`);
  }
  return {
    packages: survivors.map(({ name, directory }) => ({ name, directory })).sort((left, right) => left.name.localeCompare(right.name)),
    excluded: excludedWarnings,
  };
}

export interface PackageScanResult {
  readonly packages: readonly SapPackage[];
  readonly warnings: readonly PackageScanWarning[];
  readonly excluded: readonly PackageScanWarning[];
}

function describeScanFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof SyntaxError) {
    return `Malformed package.json: ${detail}`;
  }
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return `Unable to read package.json${code === undefined ? "" : ` (${code})`}: ${detail}`;
}

export async function scanForPackages(workspaceDirectory: string, prefix: string): Promise<PackageScanResult> {
  const normalizedPrefix = normalizePackagePrefix(prefix);
  const found = new Map<string, readonly string[]>();
  const warnings: PackageScanWarning[] = [];

  async function visit(directory: string): Promise<void> {
    let entries: readonly Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
      let name: string | undefined;
      try {
        name = await readPackageName(path.join(directory, "package.json"));
      } catch (error) {
        const reason = describeScanFailure(error);
        warnings.push({ directory, reason });
        process.stderr.write(`Warning: ${reason} in ${JSON.stringify(directory)}; skipping this directory (still scanning nested subdirectories for packages).\n`);
        name = undefined;
      }
      if (name?.startsWith(normalizedPrefix) === true) {
        found.set(name, [...(found.get(name) ?? []), directory]);
        return;
      }
    }

    const childDirectories = entries
      .filter((entry) => entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name))
      .map((entry) => path.join(directory, entry.name));
    await Promise.all(childDirectories.map(async (child) => {
      await visit(child);
    }));
  }

  await visit(path.resolve(workspaceDirectory));
  const collisionResult = excludeFallbackNameCollisions(resolveDeclaredNameCollisions(found, normalizedPrefix));
  return {
    packages: collisionResult.packages,
    warnings,
    excluded: collisionResult.excluded,
  };
}

async function prepareSymlinkDestination(linkPath: string, targetPath: string): Promise<void> {
  try {
    const stat = await lstat(linkPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(`Cannot create virtual link at ${linkPath}: path already exists and is not a symlink`);
    }
    const currentTarget = await readlink(linkPath);
    if (path.resolve(path.dirname(linkPath), currentTarget) === path.resolve(targetPath)) {
      return;
    }
    await rm(linkPath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function pruneStaleLinks(scopeDirectory: string, validNames: ReadonlySet<string>, normalizedPrefix: string): Promise<void> {
  let entries: readonly Dirent[];
  try {
    entries = await readdir(scopeDirectory, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    // Treats the scope directory as fully owned by this auto-linker: a symlink whose name doesn't
    // match a package still in scope is assumed stale and removed, without checking what it
    // actually points at. A real directory or file (e.g. a genuine npm install) is never touched
    // regardless of name, matching the same safety check prepareSymlinkDestination already applies
    // before replacing an existing link.
    if (!entry.isSymbolicLink() || validNames.has(`${normalizedPrefix}${entry.name}`)) {
      return;
    }
    await rm(path.join(scopeDirectory, entry.name), { recursive: true, force: true });
  }));
}

function firstRejection(outcomes: readonly PromiseSettledResult<void>[]): PromiseRejectedResult | undefined {
  return outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
}

export async function autoLinkPackages(packages: readonly SapPackage[], prefix: string): Promise<void> {
  const normalizedPrefix = normalizePackagePrefix(prefix);
  const scope = packageScope(prefix);
  const validNames = new Set(packages.map((sapPackage) => sapPackage.name));
  const createdLinks: string[] = [];

  async function linkOneTarget(scopeDirectory: string, sourcePackage: SapPackage, targetPackage: SapPackage): Promise<void> {
    let shortName: string;
    try {
      shortName = packageShortName(targetPackage.name, prefix);
    } catch (error) {
      // A single unlinkable name (e.g. one that only matches the bare scope) must not abort
      // linking for every other, perfectly valid package.
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Warning: Unable to link ${JSON.stringify(targetPackage.name)} into ${JSON.stringify(sourcePackage.directory)}: ${detail}\n`);
      return;
    }
    const linkPath = path.join(scopeDirectory, shortName);
    await prepareSymlinkDestination(linkPath, targetPackage.directory);
    try {
      await symlink(targetPackage.directory, linkPath, "dir");
      createdLinks.push(linkPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }

  async function linkFromSource(sourcePackage: SapPackage): Promise<void> {
    const scopeDirectory = path.join(sourcePackage.directory, "node_modules", scope);
    await mkdir(scopeDirectory, { recursive: true });
    await pruneStaleLinks(scopeDirectory, validNames, normalizedPrefix);
    const targets = packages.filter((targetPackage) => targetPackage.name !== sourcePackage.name);
    // Settled, not raced: every target in this source's scope must finish attempting its link --
    // success or failure -- before this source's own outcome is decided, so a slower sibling
    // target can never still be creating a link after the caller has already rolled everything back.
    const failure = firstRejection(await Promise.allSettled(targets.map(async (targetPackage) => {
      await linkOneTarget(scopeDirectory, sourcePackage, targetPackage);
    })));
    if (failure !== undefined) {
      throw failure.reason;
    }
  }

  const failure = firstRejection(await Promise.allSettled(packages.map(async (sourcePackage) => {
    await linkFromSource(sourcePackage);
  })));
  if (failure === undefined) {
    return;
  }
  await Promise.all(createdLinks.map(async (linkPath) => {
    try {
      await rm(linkPath, { recursive: true, force: true });
    } catch {
      // best-effort rollback; a failure removing a link during cleanup must not mask the original error.
    }
  }));
  throw failure.reason;
}
