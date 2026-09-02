import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord, readString } from "./records.js";

export interface PackageMetadata {
  readonly name: string;
  readonly version: string;
  /** Directory that holds the package.json. */
  readonly directory: string;
}

/**
 * A bundled CLI lives at `<package>/dist/cli.js`; a source file under test at
 * `<package>/src/...`; tsup chunks one level deeper. Six levels covers every
 * layout in this repo with room to spare while still failing fast on a stray
 * file outside any package.
 */
const MAX_WALK_UP = 6;

/** Parse `<directory>/package.json`; undefined when missing, unreadable, or not a manifest with name and version. */
export function readPackageManifest(directory: string): PackageMetadata | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(directory, "package.json"), "utf8");
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isRecord(parsed)) {
    return;
  }
  const name = readString(parsed, "name");
  const version = readString(parsed, "version");
  if (name === undefined || version === undefined) {
    return;
  }
  return { name, version, directory };
}

/** Walk up from `startDirectory` to the nearest package.json whose `name` is `expectedName`. */
export function findPackageMetadata(startDirectory: string, expectedName: string): PackageMetadata | undefined {
  let current = startDirectory;
  for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
    const manifest = readPackageManifest(current);
    if (manifest?.name === expectedName) {
      return manifest;
    }
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
  return;
}

/**
 * Version and name of the package that owns the calling module, read from its
 * package.json at runtime so `--version` and the self-updater can never drift
 * from the manifest the way a hand-maintained constant does. Throws when the
 * manifest cannot be found: a broken install should fail loudly, not report
 * "0.0.0".
 */
export function readPackageMetadata(importMetaUrl: string, expectedName: string): PackageMetadata {
  const startDirectory = dirname(fileURLToPath(importMetaUrl));
  const found = findPackageMetadata(startDirectory, expectedName);
  if (found === undefined) {
    throw new Error(`Cannot find the package.json of ${expectedName} above ${startDirectory}`);
  }
  return found;
}
