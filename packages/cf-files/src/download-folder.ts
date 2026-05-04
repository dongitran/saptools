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

async function walkAndDownload(
  appName: string,
  remotePath: string,
  localDir: string,
  context: CfExecContext,
  stats: WalkStats,
): Promise<void> {
  await mkdir(localDir, { recursive: true });

  const raw = await cfSsh(appName, buildListCommand(remotePath), context);
  const entries = parseListOutput(raw);

  for (const entry of entries) {
    const childRemotePath = `${remotePath}/${entry.name}`;
    const childLocalPath = join(localDir, entry.name);

    if (entry.isDirectory) {
      await walkAndDownload(appName, childRemotePath, childLocalPath, context, stats);
    } else {
      const content = await cfSshBuffer(appName, buildDownloadCommand(childRemotePath), context);
      await writeFile(childLocalPath, content);
      stats.files++;
      stats.bytes += content.byteLength;
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

  const session = await openCfSession(options.target, context);
  try {
    const stats: WalkStats = { files: 0, bytes: 0 };
    await walkAndDownload(options.target.app, remotePath, outDir, session.context, stats);
    return { outDir, files: stats.files, bytes: stats.bytes };
  } finally {
    await session.dispose();
  }
}
