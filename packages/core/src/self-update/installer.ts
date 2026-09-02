import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { errorMessage } from "../records.js";

import type { InstallKind, InstallLocation } from "./install-location.js";
import type { SpawnLike } from "./process-types.js";

export interface InstallCommand {
  readonly file: string;
  readonly args: readonly string[];
  /** The equivalent command a human would type; used in notices. */
  readonly display: string;
}

export interface BuildInstallCommandOptions {
  readonly location: InstallLocation;
  readonly packageName: string;
  readonly version: string;
  readonly registryUrl: string;
  readonly execPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly exists?: (path: string) => boolean;
  readonly realpath?: (path: string) => string;
}

export type InstallResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface RunInstallOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly spawnImpl: SpawnLike;
}

/** A global install of a ~200 KB CLI takes a few seconds; three minutes only matters on a stalled network. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 180_000;

/** What to tell a human to run; also the fallback when we cannot upgrade for them. */
export function manualInstallCommand(kind: InstallKind, spec: string): string {
  switch (kind) {
    case "pnpm-global":
      return `pnpm add -g ${spec}`;
    case "yarn-global":
      return `yarn global add ${spec}`;
    case "bun-global":
      return `bun add -g ${spec}`;
    case "volta":
      return `volta install ${spec}`;
    case "npm-global":
    case "npx":
    case "local":
    case "unknown":
      return `npm install -g ${spec}`;
  }
}

interface NpmInvocation {
  readonly file: string;
  readonly leadingArgs: readonly string[];
}

/**
 * Prefer the npm that ships with the node running us (`<bin>/npm` beside
 * `process.execPath`), executed through that same node: PATH may hold a
 * different Node installation whose npm would upgrade a different prefix. On
 * Windows the `.cmd` shim cannot be spawned without a shell, so only the
 * bundled `npm-cli.js` is used there.
 */
function resolveNpmInvocation(
  execPath: string,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
  realpath: (path: string) => string,
): NpmInvocation | undefined {
  const binDirectory = dirname(execPath);
  if (platform === "win32") {
    const cli = join(binDirectory, "node_modules", "npm", "bin", "npm-cli.js");
    return exists(cli) ? { file: execPath, leadingArgs: [cli] } : undefined;
  }
  const sibling = join(binDirectory, "npm");
  if (exists(sibling)) {
    try {
      const target = realpath(sibling);
      return target.endsWith(".js") ? { file: execPath, leadingArgs: [target] } : { file: target, leadingArgs: [] };
    } catch {
      // A dangling symlink: fall through to PATH.
    }
  }
  return { file: "npm", leadingArgs: [] };
}

function buildNpmCommand(options: BuildInstallCommandOptions, spec: string): InstallCommand | undefined {
  if (options.location.prefix === undefined) {
    return;
  }
  const npm = resolveNpmInvocation(
    options.execPath ?? process.execPath,
    options.platform ?? process.platform,
    options.exists ?? existsSync,
    options.realpath ?? ((path: string): string => realpathSync(path)),
  );
  if (npm === undefined) {
    return;
  }
  return {
    file: npm.file,
    args: [
      ...npm.leadingArgs,
      "install",
      "--global",
      "--prefix",
      options.location.prefix,
      spec,
      "--registry",
      options.registryUrl,
      "--no-fund",
      "--no-audit",
      "--no-update-notifier",
      "--loglevel=error",
    ],
    display: manualInstallCommand("npm-global", spec),
  };
}

/** The exact command that upgrades this install in place; undefined when the location cannot be upgraded by us. */
export function buildInstallCommand(options: BuildInstallCommandOptions): InstallCommand | undefined {
  const spec = `${options.packageName}@${options.version}`;
  switch (options.location.kind) {
    case "npm-global":
      return buildNpmCommand(options, spec);
    case "pnpm-global":
      return { file: "pnpm", args: ["add", "--global", spec], display: manualInstallCommand("pnpm-global", spec) };
    case "yarn-global":
      return { file: "yarn", args: ["global", "add", spec], display: manualInstallCommand("yarn-global", spec) };
    case "bun-global":
      return { file: "bun", args: ["add", "--global", spec], display: manualInstallCommand("bun-global", spec) };
    case "volta":
      return { file: "volta", args: ["install", spec], display: manualInstallCommand("volta", spec) };
    case "npx":
    case "local":
    case "unknown":
      return;
  }
}

function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1) ?? "";
}

/**
 * Run the install with no shell, no stdin, and a hard timeout. Credentials for
 * SAP never reach the package manager, and the child inherits an explicit
 * `SAPTOOLS_AUTO_UPDATE=off` so nothing it runs can start a nested update.
 * `cwd` is the temp directory so a project's `.npmrc` cannot redirect the
 * install of a global tool.
 */
export function runInstall(command: InstallCommand, options: RunInstallOptions): Promise<InstallResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  const env: NodeJS.ProcessEnv = { ...options.env, SAPTOOLS_AUTO_UPDATE: "off" };
  delete env["SAP_EMAIL"];
  delete env["SAP_PASSWORD"];

  return new Promise<InstallResult>((resolve) => {
    let child: ReturnType<SpawnLike>;
    try {
      child = options.spawnImpl(command.file, command.args, { cwd: tmpdir(), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ ok: false, reason: errorMessage(error) });
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `${command.file}: ${error.message}` });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      const detail = lastLine(stderr);
      const suffix = detail.length > 0 ? `: ${detail}` : "";
      resolve({
        ok: false,
        reason:
          signal === null
            ? `${command.display} exited with code ${String(code ?? -1)}${suffix}`
            : `${command.display} was killed by ${signal} after ${String(Math.round(timeoutMs / 1000))}s`,
      });
    });
  });
}
