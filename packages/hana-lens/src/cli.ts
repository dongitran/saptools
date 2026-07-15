#!/usr/bin/env node
import process from "node:process";

import { buildCache } from "./build-cache.js";
import { readCache } from "./cache.js";
import { describeEntity } from "./describe.js";
import { parseCacheKind } from "./scope.js";
import { findIncomingReferences, formatFieldSearchResults, formatIncomingReferences, formatSearchResults, searchDefinitions, searchFields } from "./search.js";

type BuildResult = Awaited<ReturnType<typeof buildCache>>;

const SKIP_SUMMARY_LIMIT = 5;

function requireOption(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing required option: ${name}`);
  }
  return value;
}

function readOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function requireArgument(args: readonly string[], name: string): string {
  const value = args.find((argument) => !argument.startsWith("--"));
  if (value === undefined) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return value;
}

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function aggregateCompileVia(compiled: BuildResult["compiled"]): string {
  const fallbackCount = compiled.filter((result) => result.via === "fallback").length;
  if (fallbackCount === 0) {
    return "cds";
  }
  if (fallbackCount === compiled.length) {
    return "fallback";
  }
  return `cds+fallback(${fallbackCount.toString()})`;
}

function printBuildWarnings(result: BuildResult): void {
  if (result.skipped.length > 0) {
    const names = result.skipped.slice(0, SKIP_SUMMARY_LIMIT).map((skip) => skip.package).join(", ");
    const remaining = result.skipped.length - SKIP_SUMMARY_LIMIT;
    const suffix = remaining > 0 ? `, ... (+${remaining.toString()} more)` : "";
    process.stderr.write(
      `Skipped ${result.skipped.length.toString()}/${result.packages.length.toString()} package(s): ${names}${suffix}\n`,
    );
  }
  const fallbackCount = result.compiled.filter((compiled) => compiled.via === "fallback").length;
  if (fallbackCount > 0) {
    process.stderr.write(
      `WARNING: DEGRADED regex fallback used for ${fallbackCount.toString()} package(s); aspect-inheriting entities, projections, enums and precisions are missing there.\n`,
    );
  }
}

async function runBuildCache(args: readonly string[]): Promise<void> {
  const kind = parseCacheKind(readOption(args, "--kind"));
  const result = await buildCache(
    requireOption(args, "--dir"),
    requireOption(args, "--prefix"),
    {
      allowFallback: hasFlag(args, "--allow-fallback"),
      strict: hasFlag(args, "--strict"),
      kind,
    },
  );
  printBuildWarnings(result);
  process.stdout.write(
    `cached=${Object.keys(result.ast.definitions).length.toString()} packages=${result.packages.length.toString()} file=${result.cacheFile}`
    + ` compiled=${result.compiled.length.toString()} skipped=${result.skipped.length.toString()} via=${aggregateCompileVia(result.compiled)}`
    + ` kind=${kind}\n`,
  );
}

function printHelp(): void {
  process.stdout.write("hana-lens <command>\n\nCommands:\n  build-cache --dir <workspace_path> --prefix <package_prefix> [--kind db|service|all] [--allow-fallback] [--strict]\n  search <keyword> [--regex]\n  search-field <keyword> [--regex]\n  references <entity_name>\n  describe <entity_name> [--expand] [--with-annotations]\n");
}

export async function main(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "build-cache") {
    await runBuildCache(args);
    return;
  }

  if (command === "search") {
    const keyword = requireArgument(args, "keyword");
    const ast = await readCache();
    const output = formatSearchResults(searchDefinitions(ast, keyword, hasFlag(args, "--regex")));
    process.stdout.write(output.length > 0 ? `${output}\n` : "");
    return;
  }

  if (command === "search-field") {
    const keyword = requireArgument(args, "keyword");
    const ast = await readCache();
    process.stdout.write(`${formatFieldSearchResults(keyword, searchFields(ast, keyword, hasFlag(args, "--regex")))}\n`);
    return;
  }

  if (command === "references") {
    const entityName = requireArgument(args, "entity_name");
    const ast = await readCache();
    process.stdout.write(`${formatIncomingReferences(entityName, findIncomingReferences(ast, entityName))}\n`);
    return;
  }

  if (command === "describe") {
    const entityName = requireArgument(args, "entity_name");
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
