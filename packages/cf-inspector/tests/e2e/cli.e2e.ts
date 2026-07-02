import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { ensureCliBuilt, runCli } from "./helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..");
const packageMetadata = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
) as { readonly version: string };
const packageVersion = packageMetadata.version;

async function reserveClosedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("test server did not bind to a TCP address");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err === undefined) {
        resolve();
        return;
      }
      reject(err);
    });
  });
  return address.port;
}

test("cf-inspector --version prints the package version", async () => {
  ensureCliBuilt();
  const result = await runCli(["--version"], 15_000);
  expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
  expect(result.stdout).toBe(`${packageVersion}\n`);
});

test("cf-inspector -V prints the package version", async () => {
  ensureCliBuilt();
  const result = await runCli(["-V"], 15_000);
  expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
  expect(result.stdout).toBe(`${packageVersion}\n`);
});

test("list-targets on a closed port gives actionable discovery guidance", async () => {
  ensureCliBuilt();
  const port = await reserveClosedPort();
  const result = await runCli(["list-targets", "--port", port.toString()], 15_000);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("INSPECTOR_DISCOVERY_FAILED");
  expect(result.stderr).toContain("Cannot reach Node inspector discovery");
  expect(result.stderr).toContain("/json/list");
  expect(result.stderr).toContain("ECONNREFUSED");
});
