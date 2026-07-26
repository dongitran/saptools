import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { PACKAGE_ANNOTATION } from "./types.js";
import type { CompileVia, HanaLensDefinition, HanaLensElement } from "./types.js";
import { createDefinitionRecord, isRecord } from "./validation.js";

type CdsCompile = (models: readonly string[]) => Promise<unknown>;
const IGNORED_MODEL_DIRECTORIES = new Set(["node_modules", ".git", "dist", "gen"]);

function isCdsCompile(value: unknown): value is CdsCompile {
  return typeof value === "function";
}

function resolveCdsEntry(targetDirectory: string): string | undefined {
  const bases = [pathToFileURL(path.join(targetDirectory, "package.json")).href, import.meta.url];
  for (const base of bases) {
    try {
      return createRequire(base).resolve("@sap/cds");
    } catch {
      continue;
    }
  }
  return undefined;
}

type CdsCompileAttempt =
  | { readonly outcome: "compiled"; readonly csn: unknown }
  | { readonly outcome: "unavailable"; readonly reason?: string };

// Only a failure to obtain a callable compile() (resolution miss, load failure, API
// mismatch) is fallback-eligible. Once compile() is genuinely invoked, a throw means the
// real compiler is reporting a problem with the CDS model itself, not a missing/unusable
// install, so it stays fatal -- --allow-fallback would not help and must not mask it.
// This is a deliberate call-site split, never message-content sniffing (see the
// "resembles the old module-resolution message" regression test). Known accepted limit:
// if @sap/cds ever lazily requires heavier internals inside compile() rather than at
// module load, a broken dependency there would surface here and be misreported as a model
// error; no observed real-world failure (0 of 34 audited) has matched that shape so far.
async function compileWithCds(targetDirectory: string): Promise<CdsCompileAttempt> {
  const entry = resolveCdsEntry(targetDirectory);
  if (entry === undefined) {
    return { outcome: "unavailable" };
  }
  let cdsModule: unknown;
  try {
    cdsModule = await import(pathToFileURL(entry).href);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { outcome: "unavailable", reason: `@sap/cds resolved to ${entry} but failed to load: ${message}` };
  }
  const cdsCandidate = isRecord(cdsModule) && isRecord(cdsModule["default"])
    ? cdsModule["default"]
    : cdsModule;
  if (!isRecord(cdsCandidate) || !isCdsCompile(cdsCandidate["compile"])) {
    return { outcome: "unavailable", reason: "@sap/cds resolved but exposes no compile() API" };
  }
  try {
    return { outcome: "compiled", csn: await cdsCandidate["compile"](["*"]) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `@sap/cds compiled the model in ${targetDirectory} and reported an error: ${message} `
      + "(this is a CDS model problem, not a missing or unusable @sap/cds install; --allow-fallback will not change this outcome)",
      { cause: error },
    );
  }
}

async function findCdsFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const sortedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  const files = await Promise.all(sortedEntries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_MODEL_DIRECTORIES.has(entry.name)) {
        return [];
      }
      return await findCdsFiles(fullPath);
    }
    return entry.isFile() && entry.name.endsWith(".cds") ? [fullPath] : [];
  }));
  return files.flat();
}

function parseElement(raw: string): readonly [string, HanaLensElement] | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const key = trimmed.startsWith("key ");
  const body = key ? trimmed.slice(4).trim() : trimmed;
  const [namePart, typePart] = body.split(":").map((part) => part.trim());
  if (namePart === undefined || typePart === undefined || namePart.length === 0) {
    return undefined;
  }
  // Real CDS requires "Composition of"; "Association to" is the only Association form.
  // Explicit "to one"/"of one" cardinality is also valid CDS and must not be captured as the target.
  const associationMatch = /^(Association\s+to|Composition\s+(?:to|of))(?:\s+(?:many|one)\b)?\s+([\w.]+)/u.exec(typePart);
  if (associationMatch !== null) {
    const associationTarget = associationMatch[2];
    if (associationTarget === undefined) {
      return undefined;
    }
    const associationKeyword = associationMatch[1] ?? "";
    const kind = associationKeyword.startsWith("Composition") ? "cds.Composition" : "cds.Association";
    return [namePart, { ...(key ? { key } : {}), type: kind, target: associationTarget }];
  }
  const scalarMatch = /^(\w+)(?:\((\d+)\))?/u.exec(typePart);
  if (scalarMatch === null) {
    return [namePart, { ...(key ? { key } : {}), type: typePart }];
  }
  const scalarType = scalarMatch[1] ?? typePart;
  return [namePart, {
    ...(key ? { key } : {}),
    type: `cds.${scalarType}`,
    ...(scalarMatch[2] === undefined ? {} : { length: Number.parseInt(scalarMatch[2], 10) }),
  }];
}

async function compileWithFallbackParser(): Promise<{ readonly definitions: Record<string, HanaLensDefinition> }> {
  const definitions = createDefinitionRecord();
  const files = await findCdsFiles(process.cwd());
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const namespace = /namespace\s+([\w.]+)\s*;/u.exec(source)?.[1];
    const entityMatches = source.matchAll(/entity\s+(\w+)\s*\{([^}]*)\}/gu);
    for (const match of entityMatches) {
      const entityName = match[1];
      const body = match[2];
      if (entityName === undefined || body === undefined) {
        continue;
      }
      const elements = Object.fromEntries(body.split(";").map(parseElement).filter((element): element is readonly [string, HanaLensElement] => element !== undefined));
      definitions[namespace === undefined ? entityName : `${namespace}.${entityName}`] = { kind: "entity", elements };
    }
  }
  return { definitions };
}

async function compileCsn(
  targetDirectory: string,
  allowFallback: boolean,
): Promise<{ readonly csn: unknown; readonly via: CompileVia }> {
  const attempt = await compileWithCds(targetDirectory);
  if (attempt.outcome === "compiled") {
    return { csn: attempt.csn, via: "cds" };
  }
  if (!allowFallback) {
    const detail = attempt.reason === undefined ? "" : ` (${attempt.reason})`;
    throw new Error(
      `@sap/cds is not resolvable from ${targetDirectory}${detail}. Install it in the analyzed workspace `
      + "(npm i @sap/cds) or alongside the hana-lens CLI. Pass --allow-fallback to accept a "
      + "DEGRADED cache from the regex parser (it omits projections, aspect-inheriting entities "
      + 'like "entity X : managed {", enums, and numeric precision).',
    );
  }
  return { csn: await compileWithFallbackParser(), via: "fallback" };
}

async function main(): Promise<void> {
  const [targetDirectory, packageName, allowFallbackRaw] = process.argv.slice(2);
  if (targetDirectory === undefined || packageName === undefined) {
    throw new Error("Usage: compile-worker <targetDir> <packageName> [allowFallback]");
  }
  process.chdir(targetDirectory);
  const { csn, via } = await compileCsn(targetDirectory, allowFallbackRaw === "1");
  if (!isRecord(csn) || !isRecord(csn["definitions"])) {
    throw new Error("@sap/cds returned a CSN without definitions");
  }
  const definitions = createDefinitionRecord();
  for (const [name, definition] of Object.entries(csn["definitions"])) {
    if (isRecord(definition)) {
      definitions[name] = { ...definition, [PACKAGE_ANNOTATION]: packageName } as HanaLensDefinition;
    }
  }
  process.stdout.write(`${JSON.stringify({ packageName, definitions, via })}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
