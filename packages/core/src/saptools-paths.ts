import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SAPTOOLS_DIR_NAME = ".saptools";
/** Relocates every saptools state file at once; packages may still offer their own narrower override. */
export const SAPTOOLS_ROOT_ENV = "SAPTOOLS_ROOT";

export function resolveSaptoolsRoot(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const fromEnv = env[SAPTOOLS_ROOT_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return join(homedir(), SAPTOOLS_DIR_NAME);
}

/**
 * Create `directory` (and missing parents) readable by the current user only.
 * Only the leaf has its mode enforced: parents such as `~/.saptools` itself
 * belong to every tool and keep whatever mode they already have.
 */
export function ensurePrivateDirectorySync(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Filesystems without POSIX modes (some network mounts, Windows) reject chmod; the directory still exists.
  }
}

/**
 * Replace `path` atomically: write a sibling temp file with `mode`, then
 * rename it over the target, so a concurrent reader never sees a half-written
 * file and a crash never leaves a truncated one behind.
 */
export function writeFileAtomicSync(path: string, data: string, mode = 0o600): void {
  const temp = `${path}.${String(process.pid)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(temp, data, { encoding: "utf8", mode });
    try {
      chmodSync(temp, mode);
    } catch {
      // Same as above: best effort where modes are unsupported.
    }
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Parse a JSON file; a missing or malformed file reads as undefined so corrupt state can never break a command. */
export function readJsonFileSync(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return;
  }
}
