import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { CfExecContext } from "./cf.js";
import { cfSshBuffer } from "./cf.js";
import { quoteRemoteShellArg } from "./list.js";
import { openCfSession } from "./session.js";
import type { DownloadOptions } from "./types.js";

export interface DownloadResult {
  readonly outPath: string;
  readonly bytes: number;
}

export function buildDownloadCommand(remotePath: string): string {
  return `cat -- ${quoteRemoteShellArg(remotePath)}`;
}

export async function downloadFile(
  options: DownloadOptions,
  context?: CfExecContext,
): Promise<DownloadResult> {
  const session = await openCfSession(options.target, context);
  try {
    const content = await cfSshBuffer(
      options.target.app,
      buildDownloadCommand(options.remotePath),
      session.context,
    );
    const outResolved = resolve(options.outPath);
    await mkdir(dirname(outResolved), { recursive: true });
    await writeFile(outResolved, content);

    return {
      outPath: outResolved,
      bytes: content.byteLength,
    };
  } finally {
    await session.dispose();
  }
}
