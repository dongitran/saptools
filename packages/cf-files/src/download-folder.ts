import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { CfExecContext } from "./cf.js";
import { cfSsh, cfSshBuffer } from "./cf.js";
import { buildDownloadCommand } from "./download.js";
import { buildListCommand, parseListOutput, resolveRemotePath } from "./list.js";
import { openCfSession } from "./session.js";
import { DEFAULT_APP_PATH, type DownloadFolderOptions, type DownloadFolderResult } from "./types.js";

interface WalkStats {
  files: number;
  bytes: number;
}

function normalizeFilerPath(p: string): string {
  return p.replace(/^\.?\/+/, "").replace(/\/+$/, "");
}

function pathStartsWith(path: string, prefix: string): boolean {
  if (prefix === "") { return true; }
  if (path === prefix) { return true; }
  return path.startsWith(`${prefix}/`);
}

function isExcluded(relativePath: string, excludes: readonly string[]): boolean {
  return excludes.some((p) => pathStartsWith(relativePath, p));
}

function isIncluded(relativePath: string, includes: readonly string[]): boolean {
  return includes.some((p) => pathStartsWith(relativePath, p));
}

function hasIncludeUnder(relativePath: string, includes: readonly string[]): boolean {
  return includes.some((p) => pathStartsWith(p, relativePath));
}

function shouldDownloadFile(
  relativePath: string,
  excludes: readonly string[],
  includes: readonly string[],
): boolean {
  if (!isExcluded(relativePath, excludes)) { return true; }
  return isIncluded(relativePath, includes);
}

function shouldRecurseDir(
  relativePath: string,
  excludes: readonly string[],
  includes: readonly string[],
): boolean {
  if (!isExcluded(relativePath, excludes)) { return true; }
  // Recurse if this dir is inside an include, or an include lives beneath it
  return isIncluded(relativePath, includes) || hasIncludeUnder(relativePath, includes);
}

async function walkAndDownload(
  appName: string,
  remotePath: string,
  localDir: string,
  relativePath: string,
  excludes: readonly string[],
  includes: readonly string[],
  context: CfExecContext,
  stats: WalkStats,
): Promise<void> {
  await mkdir(localDir, { recursive: true });

  const raw = await cfSsh(appName, buildListCommand(remotePath), context);
  const entries = parseListOutput(raw);

  for (const entry of entries) {
    const entryRelative =
      relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
    const childRemotePath = `${remotePath}/${entry.name}`;
    const childLocalPath = join(localDir, entry.name);

    if (entry.isDirectory) {
      if (shouldRecurseDir(entryRelative, excludes, includes)) {
        await walkAndDownload(
          appName,
          childRemotePath,
          childLocalPath,
          entryRelative,
          excludes,
          includes,
          context,
          stats,
        );
      }
    } else {
      if (shouldDownloadFile(entryRelative, excludes, includes)) {
        const content = await cfSshBuffer(
          appName,
          buildDownloadCommand(childRemotePath),
          context,
        );
        await writeFile(childLocalPath, content);
        stats.files++;
        stats.bytes += content.byteLength;
      }
    }
  }
}

export async function downloadFolder(
  options: DownloadFolderOptions,
  context?: CfExecContext,
): Promise<DownloadFolderResult> {
  const appPath = options.appPath ?? DEFAULT_APP_PATH;
  const remotePath = resolveRemotePath(options.remotePath, appPath);
  const outDir = resolve(options.outDir);
  const excludes = (options.exclude ?? []).map(normalizeFilerPath).filter(Boolean);
  const includes = (options.include ?? []).map(normalizeFilerPath).filter(Boolean);

  const session = await openCfSession(options.target, context);
  try {
    const stats: WalkStats = { files: 0, bytes: 0 };
    await walkAndDownload(
      options.target.app,
      remotePath,
      outDir,
      "",
      excludes,
      includes,
      session.context,
      stats,
    );
    return { outDir, files: stats.files, bytes: stats.bytes };
  } finally {
    await session.dispose();
  }
}

export const internals = {
  normalizeFilerPath,
  pathStartsWith,
  shouldDownloadFile,
  shouldRecurseDir,
};
