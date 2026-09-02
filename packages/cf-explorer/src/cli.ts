import process from "node:process";

import { readPackageMetadata } from "@saptools/core";

import { runProgram } from "./cli/program.js";
import { CfExplorerError } from "./core/errors.js";

export async function main(argv: readonly string[]): Promise<void> {
  await runProgram(argv, readPackageMetadata(import.meta.url, "@saptools/cf-explorer").version);
}

try {
  await main(process.argv);
} catch (error: unknown) {
  if (error instanceof CfExplorerError) {
    process.stderr.write(`Error [${error.code}]: ${error.message}\n`);
  } else {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(1);
}
