import type { Dirent } from "node:fs";
import { lstat, mkdir, readlink, readdir, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";

import type { SapPackage } from "./types.js";
import { isRecord } from "./validation.js";

const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "gen"]);

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

export async function scanForPackages(workspaceDirectory: string, prefix: string): Promise<readonly SapPackage[]> {
  const normalizedPrefix = normalizePackagePrefix(prefix);
  const found = new Map<string, string>();

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
        throw new Error(`Malformed package.json in ${directory}`, { cause: error });
      }
      if (name?.startsWith(normalizedPrefix) === true) {
        const existingDirectory = found.get(name);
        if (existingDirectory !== undefined) {
          throw new Error(`Duplicate package name ${name} in ${existingDirectory} and ${directory}`);
        }
        found.set(name, directory);
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
  return [...found.entries()].map(([name, directory]) => ({ name, directory })).sort((a, b) => a.name.localeCompare(b.name));
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

export async function autoLinkPackages(packages: readonly SapPackage[], prefix: string): Promise<void> {
  const scope = packageScope(prefix);
  await Promise.all(packages.map(async (sourcePackage) => {
    const scopeDirectory = path.join(sourcePackage.directory, "node_modules", scope);
    await mkdir(scopeDirectory, { recursive: true });
    await Promise.all(packages.filter((targetPackage) => targetPackage.name !== sourcePackage.name).map(async (targetPackage) => {
      const linkPath = path.join(scopeDirectory, packageShortName(targetPackage.name, prefix));
      await prepareSymlinkDestination(linkPath, targetPackage.directory);
      try {
        await symlink(targetPackage.directory, linkPath, "dir");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
    }));
  }));
}
