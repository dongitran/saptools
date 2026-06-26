import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  type Scenario,
  createEnv,
  prepareCase,
  readFileContent,
  runCli,
} from "./helpers.js";

const ROOT_NAME = "cf-export-e2e";

function createScenario(): Scenario {
  return {
    regions: [
      {
        key: "ap10",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        orgs: [
          {
            name: "demo-org",
            spaces: [
              {
                name: "dev",
                apps: [
                  {
                    name: "demo-app",
                    guid: "guid-demo-123",
                    envPayload: {
                      system_env_json: {
                        VCAP_SERVICES: {
                          hana: [{ name: "db", credentials: { host: "h" } }],
                        },
                      },
                      environment_variables: { MY_VAR: "42" },
                    },
                    files: {
                      "/home/vcap/app/package.json": JSON.stringify(
                        { name: "demo-app", version: "1.2.3" },
                        null,
                        2,
                      ),
                      "/home/vcap/app/pnpm-lock.yaml": "lockfileVersion: 9\n",
                      "/home/vcap/app/.cdsrc.json": JSON.stringify({ requires: ["db"] }, null, 2),
                      "/home/vcap/app/.npmrc": "//registry.example.com/:_authToken=xxx\n",
                      "/custom/root/package.json": JSON.stringify({ name: "custom-root" }, null, 2),
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

test("export (default all) writes available artifacts and default-env", async () => {
  const paths = await prepareCase(ROOT_NAME, "export-all", createScenario());
  const env = createEnv(paths);

  const { code, stdout, stderr } = await runCli(env, [
    "-r",
    "ap10",
    "-o",
    "demo-org",
    "-s",
    "dev",
    "-a",
    "demo-app",
    "--out",
    paths.workDir,
  ]);

  expect(code).toBe(0);
  expect(stderr).toBe("");

  const defaultEnvPath = join(paths.workDir, "default-env.json");
  const pkgPath = join(paths.workDir, "package.json");
  const pnpmPath = join(paths.workDir, "pnpm-lock.yaml");

  expect(existsSync(defaultEnvPath)).toBe(true);
  expect(existsSync(pkgPath)).toBe(true);
  expect(existsSync(pnpmPath)).toBe(true);

  const pkg = await readFileContent(pkgPath);
  expect(JSON.parse(pkg).name).toBe("demo-app");

  const def = await readFileContent(defaultEnvPath);
  expect(JSON.parse(def).MY_VAR).toBe("42");

  expect(stdout).toContain("Export completed for");
});

test("export with --remote-root reads from custom location", async () => {
  const paths = await prepareCase(ROOT_NAME, "export-remote-root", createScenario());
  const env = createEnv(paths);

  const { code, stdout } = await runCli(env, [
    "-r",
    "ap10",
    "-o",
    "demo-org",
    "-s",
    "dev",
    "-a",
    "demo-app",
    "--out",
    paths.workDir,
    "--remote-root",
    "/custom/root",
    "--file",
    "package.json",
  ]);

  expect(code).toBe(0);
  const pkg = await readFileContent(join(paths.workDir, "package.json"));
  expect(JSON.parse(pkg).name).toBe("custom-root");
  expect(stdout).toContain("package.json");
});

test("export --file selects subset and skips missing", async () => {
  const paths = await prepareCase(ROOT_NAME, "export-selective", createScenario());
  const env = createEnv(paths);

  const { code, stdout } = await runCli(env, [
    "-r",
    "ap10",
    "-o",
    "demo-org",
    "-s",
    "dev",
    "-a",
    "demo-app",
    "--out",
    paths.workDir,
    "--file",
    "package.json",
    "--file",
    "package-lock.json",
  ]);

  expect(code).toBe(0);
  expect(existsSync(join(paths.workDir, "package.json"))).toBe(true);
  // package-lock not present in scenario → skipped
  expect(stdout).toContain("Skipped");
});

test("requires target flags", async () => {
  const paths = await prepareCase(ROOT_NAME, "export-missing-flags", createScenario());
  const env = createEnv(paths);

  // Provide app but omit region/org/space to test our resolution + require
  const { code, stderr } = await runCli(env, ["--out", paths.workDir, "-a", "demo-app"]);
  expect(code).not.toBe(0);
  expect(stderr).toContain("--region");
});
