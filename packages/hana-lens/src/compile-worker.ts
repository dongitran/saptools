import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { PACKAGE_ANNOTATION } from "./types.js";
import type { CompileVia, HanaLensDefinition, HanaLensElement } from "./types.js";
import { isRecord } from "./validation.js";

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

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- undefined is the explicit resolution-miss sentinel.
async function compileWithCds(targetDirectory: string): Promise<unknown | undefined> {
  const entry = resolveCdsEntry(targetDirectory);
  if (entry === undefined) {
    return undefined;
  }
  const cdsModule: unknown = await import(pathToFileURL(entry).href);
  const cdsCandidate = isRecord(cdsModule) && isRecord(cdsModule["default"])
    ? cdsModule["default"]
    : cdsModule;
  if (!isRecord(cdsCandidate) || !isCdsCompile(cdsCandidate["compile"])) {
    throw new Error("@sap/cds resolved but exposes no compile() API");
  }
  return await cdsCandidate["compile"](["*"]);
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
  const associationMatch = /^(Association|Composition)\s+to(?:\s+many)?\s+([\w.]+)/u.exec(typePart);
  if (associationMatch !== null) {
    const associationTarget = associationMatch[2];
    if (associationTarget === undefined) {
      return undefined;
    }
    const kind = associationMatch[1] === "Composition" ? "cds.Composition" : "cds.Association";
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
  const definitions: Record<string, HanaLensDefinition> = {};
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
  const csn = await compileWithCds(targetDirectory);
  if (csn !== undefined) {
    return { csn, via: "cds" };
  }
  if (!allowFallback) {
    throw new Error(
      `@sap/cds is not resolvable from ${targetDirectory}. Install it in the analyzed workspace `
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
  const definitions: Record<string, HanaLensDefinition> = {};
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
