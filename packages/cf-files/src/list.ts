import type { CfExecContext } from "./cf.js";
import { cfSsh } from "./cf.js";
import { openCfSession } from "./session.js";
import type { ListEntry, ListOptions } from "./types.js";

function assertSafeRemotePath(path: string): void {
  if (path.includes("\0") || path.includes("\n") || path.includes("\r")) {
    throw new Error("Remote path must not contain NUL or newline characters");
  }
}

export function quoteRemoteShellArg(value: string): string {
  assertSafeRemotePath(value);
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildListCommand(remotePath: string): string {
  return `ls -la -- ${quoteRemoteShellArg(remotePath)}`;
}

export function resolveRemotePath(target: string, appPath: string): string {
  if (target.startsWith("/")) {
    return target;
  }
  const base = appPath.replace(/\/+$/, "");
  const clean = target.replace(/^\/+/, "");
  return clean.length === 0 ? base : `${base}/${clean}`;
}

export function parseListOutput(raw: string): readonly ListEntry[] {
  const entries: ListEntry[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith("total ")) {
      continue;
    }
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) {
      continue;
    }
    const permissions = parts[0] ?? "";
    if (permissions.length === 0) {
      continue;
    }
    const sizeStr = parts[4] ?? "0";
    const size = Number.parseInt(sizeStr, 10);
    const name = parts.slice(8).join(" ");
    if (name.length === 0 || name === "." || name === "..") {
      continue;
    }
    entries.push({
      name,
      isDirectory: permissions.startsWith("d"),
      permissions,
      size: Number.isFinite(size) ? size : 0,
    });
  }
  return entries;
}

export async function listFiles(
  options: ListOptions,
  context?: CfExecContext,
): Promise<readonly ListEntry[]> {
  const session = await openCfSession(options.target, context);
  try {
    const raw = await cfSsh(options.target.app, buildListCommand(options.remotePath), session.context);
    return parseListOutput(raw);
  } finally {
    await session.dispose();
  }
}
