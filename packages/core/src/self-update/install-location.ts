import { accessSync, constants, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

import { findPackageMetadata } from "../package-metadata.js";
import { errorMessage } from "../records.js";

export type InstallKind = "npm-global" | "pnpm-global" | "yarn-global" | "bun-global" | "volta" | "npx" | "local" | "unknown";

export interface InstallLocation {
  readonly kind: InstallKind;
  /** Directory holding the CLI's package.json, when it could be found. */
  readonly packageDirectory: string | undefined;
  /** npm global prefix (`npm prefix -g`), npm-global installs only. */
  readonly prefix: string | undefined;
  /** Whether this user can replace the installed files without escalating privileges. */
  readonly writable: boolean;
  readonly detail: string;
}

export interface DetectInstallLocationOptions {
  readonly binPath: string;
  readonly packageName: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly realpath?: (path: string) => string;
  readonly isWritable?: (path: string) => boolean;
}

const UPGRADABLE_KINDS: ReadonlySet<InstallKind> = new Set<InstallKind>(["npm-global", "pnpm-global", "yarn-global", "bun-global", "volta"]);

export function isUpgradableKind(kind: InstallKind): boolean {
  return UPGRADABLE_KINDS.has(kind);
}

function defaultIsWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function isPnpmGlobal(posixDirectory: string, env: NodeJS.ProcessEnv): boolean {
  // ~/Library/pnpm/global/5/... (macOS), ~/.local/share/pnpm/global/5/... (Linux), or a custom PNPM_HOME.
  if (posixDirectory.includes("/pnpm/global/")) {
    return true;
  }
  const home = env["PNPM_HOME"];
  return home !== undefined && home.length > 0 && posixDirectory.startsWith(`${toPosix(home).replace(/\/+$/, "")}/global/`);
}

/** `<node_modules>` that directly holds `<node_modules>/@scope/name` or `<node_modules>/name`. */
function nodeModulesRootOf(packageDirectory: string): string | undefined {
  const parent = dirname(packageDirectory);
  if (basename(parent) === "node_modules") {
    return parent;
  }
  const grandparent = dirname(parent);
  return basename(grandparent) === "node_modules" ? grandparent : undefined;
}

/**
 * npm's global layout is `<prefix>/lib/node_modules` on POSIX and
 * `<prefix>/node_modules` on Windows, where the default prefix directory is
 * named `npm`. Anything else under a `node_modules` is a project-local install.
 */
function npmPrefixFor(packageDirectory: string, platform: NodeJS.Platform): string | undefined {
  const nodeModules = nodeModulesRootOf(packageDirectory);
  if (nodeModules === undefined) {
    return;
  }
  const parent = dirname(nodeModules);
  if (platform === "win32") {
    return basename(parent).toLowerCase() === "npm" ? parent : undefined;
  }
  return basename(parent) === "lib" ? dirname(parent) : undefined;
}

function classifyKind(packageDirectory: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): InstallKind {
  const posix = toPosix(packageDirectory);
  if (posix.includes("/_npx/") || /\/dlx-[^/]+\//.test(posix) || posix.includes("/pnpm/dlx/") || posix.includes("/.cache/pnpm/dlx")) {
    return "npx";
  }
  if (posix.includes("/.volta/tools/image/packages/")) {
    return "volta";
  }
  if (posix.includes("/.bun/install/global/")) {
    return "bun-global";
  }
  if (posix.includes("/.config/yarn/global/") || posix.includes("/yarn/global/node_modules/")) {
    return "yarn-global";
  }
  if (isPnpmGlobal(posix, env)) {
    return "pnpm-global";
  }
  if (!posix.includes("/node_modules/")) {
    return "local";
  }
  return npmPrefixFor(packageDirectory, platform) === undefined ? "local" : "npm-global";
}

function writableForUpgrade(
  packageDirectory: string,
  prefix: string | undefined,
  platform: NodeJS.Platform,
  isWritable: (path: string) => boolean,
): boolean {
  // The package itself, its scope folder, the node_modules root (npm rewrites .package-lock.json) and the bin folder all get touched.
  const targets = [packageDirectory, dirname(packageDirectory)];
  const nodeModules = nodeModulesRootOf(packageDirectory);
  if (nodeModules !== undefined) {
    targets.push(nodeModules);
  }
  if (prefix !== undefined) {
    targets.push(platform === "win32" ? prefix : join(prefix, "bin"));
  }
  return targets.every((target) => isWritable(target));
}

function describe(kind: InstallKind, packageDirectory: string, prefix: string | undefined): string {
  if (kind === "npm-global" && prefix !== undefined) {
    return `npm global install under ${prefix}`;
  }
  return `${kind} install at ${packageDirectory}`;
}

function unknownLocation(detail: string): InstallLocation {
  return { kind: "unknown", packageDirectory: undefined, prefix: undefined, writable: false, detail };
}

/**
 * Where does the running CLI come from, and which package manager owns it?
 * Decided from the real path of the executing script, never from PATH or
 * `npm prefix -g`: the install we upgrade must be the one we are running.
 */
export function detectInstallLocation(options: DetectInstallLocationOptions): InstallLocation {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const realpath = options.realpath ?? ((path: string): string => realpathSync(path));
  const isWritable = options.isWritable ?? defaultIsWritable;

  let resolvedBin: string;
  try {
    resolvedBin = realpath(options.binPath);
  } catch (error) {
    return unknownLocation(`cannot resolve ${options.binPath}: ${errorMessage(error)}`);
  }
  const manifest = findPackageMetadata(dirname(resolvedBin), options.packageName);
  if (manifest === undefined) {
    return unknownLocation(`no package.json for ${options.packageName} above ${resolvedBin}`);
  }

  const packageDirectory = manifest.directory;
  const kind = classifyKind(packageDirectory, platform, env);
  const prefix = kind === "npm-global" ? npmPrefixFor(packageDirectory, platform) : undefined;
  const writable = isUpgradableKind(kind) && writableForUpgrade(packageDirectory, prefix, platform, isWritable);
  return { kind, packageDirectory, prefix, writable, detail: describe(kind, packageDirectory, prefix) };
}
