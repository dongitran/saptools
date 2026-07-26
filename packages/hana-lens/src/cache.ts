import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { CACHE_FILE_NAME, PACKAGE_ANNOTATION } from "./types.js";
import type { CompileResult, HanaLensCsn } from "./types.js";
import { createDefinitionRecord, isRecord, parseCsn } from "./validation.js";

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

// Keep this property-presence check aligned with cache scope classification in scope.ts.
function isProjection(definition: unknown): boolean {
  return isRecord(definition)
    && (definition["query"] !== undefined || definition["projection"] !== undefined);
}

// A missing `elements` map counts as zero elements, the same as an empty one -- both mean
// "this copy offers no named columns" for the purpose of comparing completeness.
function elementKeys(definition: unknown): ReadonlySet<string> {
  if (!isRecord(definition) || !isRecord(definition["elements"])) {
    return new Set();
  }
  return new Set(Object.keys(definition["elements"]));
}

function isStrictSupersetOf(candidate: ReadonlySet<string>, other: ReadonlySet<string>): boolean {
  return candidate.size > other.size && [...other].every((key) => candidate.has(key));
}

// Content-based, order-independent: whichever copy of a conflicting FQN is processed first,
// the one with the strictly larger (superset) element set always ends up cached. Only when
// neither is a superset of the other (equal element counts, or genuinely divergent modelling)
// does this fall back to the pre-existing non-projection preference -- and even then, never
// installing a definition with fewer elements than the one it would replace.
function preferNextDefinition(previousDefinition: unknown, nextDefinition: unknown): boolean {
  const previousKeys = elementKeys(previousDefinition);
  const nextKeys = elementKeys(nextDefinition);
  if (isStrictSupersetOf(nextKeys, previousKeys)) {
    return true;
  }
  if (isStrictSupersetOf(previousKeys, nextKeys)) {
    return false;
  }
  const previousIsProjection = isProjection(previousDefinition);
  const nextIsProjection = isProjection(nextDefinition);
  if (previousIsProjection !== nextIsProjection) {
    return previousIsProjection && nextKeys.size >= previousKeys.size;
  }
  // Same projection-ness on both sides, and neither's element set is a superset of the other's
  // (e.g. disjoint fields {A,B} vs {B,C}): genuinely incomparable copies of the same FQN, already
  // flagged as a conflict. Break the tie by content rather than arrival order, so which copy wins
  // -- and therefore the cache itself -- stays identical across repeated builds regardless of
  // package scan order.
  return definitionSignature(nextDefinition) > definitionSignature(previousDefinition);
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
  const definitions = createDefinitionRecord();
  const owners = new Map<string, string>();
  const conflicts: DefinitionConflict[] = [];
  const conflictingNames = new Set<string>();
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
      conflictingNames.add(definitionName);
      if (preferNextDefinition(previousDefinition, definition)) {
        owners.set(definitionName, result.packageName);
        definitions[definitionName] = definition;
      }
    }
  }
  if (conflicts.length > 0) {
    const shownConflicts = conflicts.slice(0, 5);
    const detail = shownConflicts
      .map((conflict) => `${conflict.name} (${conflict.firstOwner} vs ${conflict.nextOwner})`)
      .join("; ");
    const shownNameCount = new Set(shownConflicts.map((conflict) => conflict.name)).size;
    const remaining = conflictingNames.size - shownNameCount;
    const detailSuffix = remaining > 0 ? `, ... (+${remaining.toString()} more name(s))` : "";
    const scope = `${conflictingNames.size.toString()} definition name(s) defined differently in >1 package `
      + `(${conflicts.length.toString()} conflicting copies)`;
    if (strict) {
      throw new Error(`Strict mode: ${scope}: ${detail}${detailSuffix}`);
    }
    process.stderr.write(`WARNING: ${scope}; kept one, others dropped: ${detail}${detailSuffix}\n`);
  }
  return { definitions };
}

export async function writeCache(
  workspaceDirectory: string,
  results: readonly CompileResult[],
  strict = false,
): Promise<HanaLensCsn> {
  const csn = mergeCompileResults(results, strict);
  const finalPath = cachePath(workspaceDirectory);
  const tempPath = `${finalPath}.tmp-${randomUUID()}`;
  try {
    await writeFile(tempPath, JSON.stringify(csn), "utf8");
    await rename(tempPath, finalPath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // best-effort cleanup; a missing temp file (writeFile never ran) is not itself an error.
    }
    throw error;
  }
  return csn;
}
