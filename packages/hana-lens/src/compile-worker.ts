import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { PACKAGE_ANNOTATION } from "./types.js";
import type { HanaLensDefinition, HanaLensElement } from "./types.js";
import { isRecord } from "./validation.js";

type CdsCompile = (models: readonly string[]) => Promise<unknown>;
const IGNORED_MODEL_DIRECTORIES = new Set(["node_modules", ".git", "dist", "gen"]);

function isCdsCompile(value: unknown): value is CdsCompile {
  return typeof value === "function";
}

async function compileWithCds(): Promise<unknown> {
  const cdsModule: unknown = await import("@sap/cds");
  if (!isRecord(cdsModule)) {
    throw new Error("@sap/cds compile API is unavailable");
  }
  const cdsCandidate = isRecord(cdsModule["default"]) ? cdsModule["default"] : cdsModule;
  if (!isCdsCompile(cdsCandidate["compile"])) {
    throw new Error("@sap/cds compile API is unavailable");
  }
  return await cdsCandidate["compile"](["*"]);
}

async function findCdsFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(entries.map(async (entry) => {
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

async function compileCsn(): Promise<unknown> {
  try {
    return await compileWithCds();
  } catch (error) {
    if (error instanceof Error && error.message.includes("Cannot find package '@sap/cds'")) {
      return await compileWithFallbackParser();
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const [targetDirectory, packageName] = process.argv.slice(2);
  if (targetDirectory === undefined || packageName === undefined) {
    throw new Error("Usage: compile-worker <targetDir> <packageName>");
  }
  process.chdir(targetDirectory);
  const csn = await compileCsn();
  if (!isRecord(csn) || !isRecord(csn["definitions"])) {
    throw new Error("@sap/cds returned a CSN without definitions");
  }
  const definitions: Record<string, HanaLensDefinition> = {};
  for (const [name, definition] of Object.entries(csn["definitions"])) {
    if (isRecord(definition)) {
      definitions[name] = { ...definition, [PACKAGE_ANNOTATION]: packageName } as HanaLensDefinition;
    }
  }
  process.stdout.write(`${JSON.stringify({ packageName, definitions })}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
