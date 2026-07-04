#!/usr/bin/env node
import process from "node:process";

import { buildCache } from "./build-cache.js";
import { readCache } from "./cache.js";
import { describeEntity } from "./describe.js";
import { findIncomingReferences, formatFieldSearchResults, formatIncomingReferences, formatSearchResults, searchDefinitions, searchFields } from "./search.js";

function requireOption(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing required option: ${name}`);
  }
  return value;
}

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function printHelp(): void {
  process.stdout.write("hana-lens <command>\n\nCommands:\n  build-cache --dir <workspace_path> --prefix <package_prefix>\n  search <keyword> [--regex]\n  search-field <keyword> [--regex]\n  references <entity_name>\n  describe <entity_name> [--expand] [--with-annotations]\n");
}

export async function main(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "build-cache") {
    const result = await buildCache(requireOption(args, "--dir"), requireOption(args, "--prefix"));
    process.stdout.write(`cached=${Object.keys(result.ast.definitions).length.toString()} packages=${result.packages.length.toString()} file=${result.cacheFile}\n`);
    return;
  }

  if (command === "search") {
    const keyword = args.find((arg) => !arg.startsWith("--"));
    if (keyword === undefined) {
      throw new Error("Missing required argument: keyword");
    }
    const ast = await readCache();
    const output = formatSearchResults(searchDefinitions(ast, keyword, hasFlag(args, "--regex")));
    process.stdout.write(output.length > 0 ? `${output}\n` : "");
    return;
  }

  if (command === "search-field") {
    const keyword = args.find((arg) => !arg.startsWith("--"));
    if (keyword === undefined) {
      throw new Error("Missing required argument: keyword");
    }
    const ast = await readCache();
    process.stdout.write(`${formatFieldSearchResults(keyword, searchFields(ast, keyword, hasFlag(args, "--regex")))}\n`);
    return;
  }

  if (command === "references") {
    const entityName = args.find((arg) => !arg.startsWith("--"));
    if (entityName === undefined) {
      throw new Error("Missing required argument: entity_name");
    }
    const ast = await readCache();
    process.stdout.write(`${formatIncomingReferences(entityName, findIncomingReferences(ast, entityName))}\n`);
    return;
  }

  if (command === "describe") {
    const entityName = args.find((arg) => !arg.startsWith("--"));
    if (entityName === undefined) {
      throw new Error("Missing required argument: entity_name");
    }
    const ast = await readCache();
    process.stdout.write(`${describeEntity(ast, entityName, hasFlag(args, "--expand"), hasFlag(args, "--with-annotations"))}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}
