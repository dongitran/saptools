import { spawn } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { CfExecContext } from "./cf.js";
import { cfSshBuffer } from "./cf.js";
import { quoteRemoteShellArg, resolveRemotePath } from "./list.js";
import { openCfSession } from "./session.js";
import { DEFAULT_APP_PATH, type DownloadFolderOptions, type DownloadFolderResult } from "./types.js";

const TAR_MAX_BUFFER = 256 * 1024 * 1024;

export function normalizeFilerPath(p: string): string {
  const normalized = p.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Filter paths must not contain . or .. segments");
  }
  return normalized;
}

export function pathStartsWith(path: string, prefix: string): boolean {
  if (prefix === "") { return true; }
  if (path === prefix) { return true; }
  return path.startsWith(`${prefix}/`);
}

function uniquePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)];
}

function removePathsCoveredByIncludes(
  excludes: readonly string[],
  includes: readonly string[],
): readonly string[] {
  return excludes.filter((exclude) => !includes.some((include) => pathStartsWith(exclude, include)));
}

function removeNestedPaths(paths: readonly string[]): readonly string[] {
  return paths.filter(
    (path) => !paths.some((candidate) => candidate !== path && pathStartsWith(path, candidate)),
  );
}

function buildFindPrintCommand(path: string): string {
  return `find -L ${quoteRemoteShellArg(path)} \\( -type d -o -type f \\) -print0`;
}

function buildPrunedFindCommand(excludes: readonly string[]): string {
  const pruneParts = excludes
    .map((exclude) => `-path ${quoteRemoteShellArg(`./${exclude}`)}`)
    .join(" -o ");
  return `find -L . \\( ${pruneParts} \\) -prune -o \\( -type d -o -type f \\) -print0`;
}

export function buildTarCommand(
  remotePath: string,
  excludes: readonly string[],
  includes: readonly string[],
): string {
  const base = quoteRemoteShellArg(remotePath);
  const uniqueExcludes = removeNestedPaths(uniquePaths(excludes));
  const uniqueIncludes = removeNestedPaths(uniquePaths(includes));
  const activeExcludes = removePathsCoveredByIncludes(uniqueExcludes, uniqueIncludes);
  const overrideIncludes = uniqueIncludes.filter((include) =>
    activeExcludes.some((exclude) => pathStartsWith(include, exclude) && include !== exclude),
  );

  if (activeExcludes.length === 0) {
    return `tar --dereference -czf - -C ${base} .`;
  }

  if (overrideIncludes.length === 0) {
    const excFlags = activeExcludes
      .map((exclude) => `--exclude=${quoteRemoteShellArg(`./${exclude}`)}`)
      .join(" ");
    return `tar --dereference -czf - -C ${base} ${excFlags} .`;
  }

  const mainFind = buildPrunedFindCommand(activeExcludes);
  const overrideFinds = overrideIncludes
    .map((include) => `${buildFindPrintCommand(`./${include}`)} 2>/dev/null`)
    .join("; ");
  const fileList = `{ ${mainFind}; ${overrideFinds}; }`;

  return `cd ${base} && ${fileList} | tar --null --dereference --no-recursion -czf - -T -`;
}

function extractTarBuffer(buffer: Buffer, outDir: string): Promise<void> {
  return new Promise<void>((res, rej) => {
    const proc = spawn("tar", ["-xzf", "-", "-C", outDir]);
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", rej);
    proc.on("close", (code) => {
      if (code === 0) {
        res();
      } else {
        rej(new Error(`tar extraction failed (exit ${String(code ?? "?")}): ${stderr.trim()}`));
      }
    });
    proc.stdin.write(buffer);
    proc.stdin.end();
  });
}

async function countExtracted(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;

  async function walk(d: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    for (const entry of entries) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else if (entry.isFile()) {
        const s = await stat(p);
        files++;
        bytes += s.size;
      }
    }
  }

  await walk(dir);
  return { files, bytes };
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

  const tarCmd = buildTarCommand(remotePath, excludes, includes);

  await mkdir(outDir, { recursive: true });

  const session = await openCfSession(options.target, context);
  try {
    const tarBuffer = await cfSshBuffer(
      options.target.app,
      tarCmd,
      session.context,
      TAR_MAX_BUFFER,
    );
    await extractTarBuffer(tarBuffer, outDir);
    const { files, bytes } = await countExtracted(outDir);
    return { outDir, files, bytes };
  } finally {
    await session.dispose();
  }
}

export const internals = {
  normalizeFilerPath,
  pathStartsWith,
  buildTarCommand,
};
