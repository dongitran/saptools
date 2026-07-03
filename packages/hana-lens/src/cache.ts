import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { CACHE_FILE_NAME } from "./types.js";
import type { CompileResult, HanaLensCsn, HanaLensDefinition } from "./types.js";
import { parseCsn } from "./validation.js";

export function cachePath(workspaceDirectory = process.cwd()): string {
  return path.join(workspaceDirectory, CACHE_FILE_NAME);
}

export async function readCache(workspaceDirectory = process.cwd()): Promise<HanaLensCsn> {
  const raw = await readFile(cachePath(workspaceDirectory), "utf8").catch((error: unknown) => {
    throw new Error(`Unable to read ${CACHE_FILE_NAME}. Run hana-lens build-cache first.`, { cause: error });
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${CACHE_FILE_NAME} contains malformed JSON`, { cause: error });
  }
  return parseCsn(parsed);
}

export function mergeCompileResults(results: readonly CompileResult[]): HanaLensCsn {
  const definitions: Record<string, HanaLensDefinition> = {};
  const owners = new Map<string, string>();
  for (const result of results) {
    for (const [definitionName, definition] of Object.entries(result.definitions)) {
      const previousOwner = owners.get(definitionName);
      if (previousOwner !== undefined) {
        throw new Error(`Duplicate CSN definition ${definitionName} from ${previousOwner} and ${result.packageName}`);
      }
      owners.set(definitionName, result.packageName);
      definitions[definitionName] = definition;
    }
  }
  return { definitions };
}

export async function writeCache(workspaceDirectory: string, results: readonly CompileResult[]): Promise<HanaLensCsn> {
  const csn = mergeCompileResults(results);
  await writeFile(cachePath(workspaceDirectory), JSON.stringify(csn), "utf8");
  return csn;
}
