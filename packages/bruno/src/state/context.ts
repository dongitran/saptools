import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { brunoContextPath } from "../collection/paths.js";
import type { BrunoContext } from "../types.js";

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
