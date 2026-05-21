import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { brunoCliStatePath, brunoContextPath } from "../collection/paths.js";
import type { BrunoContext } from "../types.js";

export interface BrunoCliState {
  readonly rootDir: string;
  readonly updatedAt: string;
}

export async function readContext(): Promise<BrunoContext | undefined> {
  try {
    const raw = await readFile(brunoContextPath(), "utf8");
    return JSON.parse(raw) as BrunoContext;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

export async function writeContext(ctx: Omit<BrunoContext, "updatedAt">): Promise<BrunoContext> {
  const updated: BrunoContext = { ...ctx, updatedAt: new Date().toISOString() };
  const path = brunoContextPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}

export async function readBrunoCliState(): Promise<BrunoCliState | undefined> {
  try {
    const raw = await readFile(brunoCliStatePath(), "utf8");
    return JSON.parse(raw) as BrunoCliState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

export async function writeBrunoCliState(input: { rootDir: string }): Promise<BrunoCliState> {
  const next: BrunoCliState = {
    rootDir: input.rootDir,
    updatedAt: new Date().toISOString(),
  };
  const path = brunoCliStatePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}
