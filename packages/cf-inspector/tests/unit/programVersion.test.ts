import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { main } from "../../src/cli/program.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..");
const packageMetadata = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
) as { readonly version: string };
const packageVersion = packageMetadata.version;

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const previousWrite = process.stdout.write.bind(process.stdout);
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = previousWrite;
  }
  return stdout;
}

describe("cf-inspector version", () => {
  it("prints the package version for --version without requiring a subcommand", async () => {
    const stdout = await captureStdout(async () => {
      await expect(main(["node", "cf-inspector", "--version"])).rejects.toThrow(/process\.exit unexpectedly called/);
    });
    expect(stdout).toBe(`${packageVersion}\n`);
  });

  it("prints the package version for -V", async () => {
    const stdout = await captureStdout(async () => {
      await expect(main(["node", "cf-inspector", "-V"])).rejects.toThrow(/process\.exit unexpectedly called/);
    });
    expect(stdout).toBe(`${packageVersion}\n`);
  });
});
