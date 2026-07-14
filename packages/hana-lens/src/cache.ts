import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { CACHE_FILE_NAME, PACKAGE_ANNOTATION } from "./types.js";
import type { CompileResult, HanaLensCsn, HanaLensDefinition } from "./types.js";
import { isRecord, parseCsn } from "./validation.js";

interface DefinitionConflict {
  readonly name: string;
  readonly firstOwner: string;
  readonly nextOwner: string;
}

function normalizeSignatureValue(value: unknown, omitPackageAnnotation = false): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSignatureValue(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  const keys = Object.keys(value)
    .filter((key) => !omitPackageAnnotation || key !== PACKAGE_ANNOTATION)
    .sort();
  return Object.fromEntries(keys.map((key) => [key, normalizeSignatureValue(value[key])]));
}

function definitionSignature(definition: unknown): string {
  if (!isRecord(definition)) {
    return "∅";
  }
  return JSON.stringify(normalizeSignatureValue(definition, true));
}

function isProjection(definition: unknown): boolean {
  return isRecord(definition)
    && (definition["query"] !== undefined || definition["projection"] !== undefined);
}

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

export function mergeCompileResults(results: readonly CompileResult[], strict = false): HanaLensCsn {
  const definitions: Record<string, HanaLensDefinition> = {};
  const owners = new Map<string, string>();
  const conflicts: DefinitionConflict[] = [];
  for (const result of results) {
    for (const [definitionName, definition] of Object.entries(result.definitions)) {
      const previousOwner = owners.get(definitionName);
      if (previousOwner === undefined) {
        owners.set(definitionName, result.packageName);
        definitions[definitionName] = definition;
        continue;
      }
      const previousDefinition = definitions[definitionName];
      if (definitionSignature(previousDefinition) === definitionSignature(definition)) {
        continue;
      }
      conflicts.push({ name: definitionName, firstOwner: previousOwner, nextOwner: result.packageName });
      if (isProjection(previousDefinition) && !isProjection(definition)) {
        owners.set(definitionName, result.packageName);
        definitions[definitionName] = definition;
      }
    }
  }
  if (conflicts.length > 0) {
    const detail = conflicts.slice(0, 5)
      .map((conflict) => `${conflict.name} (${conflict.firstOwner} vs ${conflict.nextOwner})`)
      .join("; ");
    if (strict) {
      throw new Error(`Strict mode: ${conflicts.length.toString()} conflicting definition name(s): ${detail}`);
    }
    process.stderr.write(
      `WARNING: ${conflicts.length.toString()} definition name(s) defined differently in >1 package; kept one, others dropped: ${detail}\n`,
    );
  }
  return { definitions };
}

export async function writeCache(
  workspaceDirectory: string,
  results: readonly CompileResult[],
  strict = false,
): Promise<HanaLensCsn> {
  const csn = mergeCompileResults(results, strict);
  await writeFile(cachePath(workspaceDirectory), JSON.stringify(csn), "utf8");
  return csn;
}
