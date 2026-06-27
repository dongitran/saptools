import { cfSsh, buildRemoteFilePaths, parseRemoteFileContent, REMOTE_CONTENT_SENTINEL, buildCatCommand } from "./cf.js";
import type { CfExecContext } from "./types.js";

export interface FetchRemoteTextOptions {
  readonly appName: string;
  readonly fileName: string;
  readonly remoteRoot?: string | undefined;
  readonly context?: CfExecContext;
}

/**
 * Fetch a text file from the CF app container using cf ssh.
 * Tries remoteRoot (if provided) first, then standard fallbacks.
 * Returns null when the file does not exist in any candidate location.
 */
export async function fetchRemoteTextFile(options: FetchRemoteTextOptions): Promise<string | null> {
  const paths = buildRemoteFilePaths(options.fileName, options.remoteRoot);

  for (const remotePath of paths) {
    try {
      const cmd = buildCatCommand(remotePath);
      const stdout = await cfSsh(options.appName, cmd, options.context);
      const content = parseRemoteFileContent(stdout);
      if (content !== null) {
        return content;
      }
    } catch (err: unknown) {
      // If the file is not found, our script exits with 66.
      // Other errors (like SSH failure, app stopped) should be thrown.
      const cause = err && typeof err === "object" && "cause" in err ? (err as any).cause : undefined;
      if (cause && cause.code === 66) {
        continue;
      }
      throw err;
    }
  }

  return null;
}

export { buildRemoteFilePaths, buildCatCommand, parseRemoteFileContent, REMOTE_CONTENT_SENTINEL };
