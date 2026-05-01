import { readFileSync } from "node:fs";
import process from "node:process";

import { runProgram } from "./cli/program.js";
import { CfExplorerError } from "./core/errors.js";

interface PackageJsonVersion {
  readonly version: string;
}

function readPackageVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isPackageJsonVersion(parsed)) {
    throw new CfExplorerError("UNSAFE_INPUT", "Package version metadata is missing.");
  }
  return parsed.version;
}

function isPackageJsonVersion(value: unknown): value is PackageJsonVersion {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly version?: unknown }).version === "string"
  );
}

export async function main(argv: readonly string[]): Promise<void> {
  await runProgram(argv, readPackageVersion());
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
