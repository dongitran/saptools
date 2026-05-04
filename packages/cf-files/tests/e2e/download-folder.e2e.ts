import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  type CasePaths,
  type Scenario,
  createEnv,
  prepareCase,
  readFakeLog,
  runCli,
} from "./helpers.js";

const ROOT_NAME = "cf-files-folder-e2e";
const TARGET_ARGS = [
  "--region",
  "ap10",
  "--org",
  "demo-org",
  "--space",
  "dev",
  "--app",
  "demo-app",
] as const;

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
                    vcapServices: {},
                    files: {
                      "/home/vcap/app/package.json": JSON.stringify(
                        { name: "demo-app", version: "1.0.0" },
                        null,
                        2,
                      ),
                      "/home/vcap/app/binary.dat": {
                        base64: Buffer.from([0x00, 0xff, 0x01, 0x80]).toString("base64"),
                      },
                      "/home/vcap/app/src/main.js": "module.exports = {};\n",
                      "/home/vcap/app/src/handlers/ping.js": "module.exports = () => {};\n",
                      "/home/vcap/app/weird files/it's $(safe); name.txt": "quoted path\n",
                      "/custom/root/readme.txt": "custom root file\n",
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

function createFilterScenario(): Scenario {
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
                    vcapServices: {},
                    files: {
                      "/home/vcap/app/index.js": "module.exports = {};\n",
                      "/home/vcap/app/lib/helper.js": "exports.help = true;\n",
                      "/home/vcap/app/node_modules/@vendor/lib/index.js": "// vendor lib\n",
                      "/home/vcap/app/node_modules/@vendor/lib/utils.js": "// vendor utils\n",
                      "/home/vcap/app/node_modules/other-pkg/index.js": "// other\n",
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

function createSymlinkScenario(): Scenario {
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
                    vcapServices: {},
                    files: {
                      "/home/vcap/app/index.js": "module.exports = {};\n",
                      "/home/vcap/app/.store/@scope+pkg@1.0.0/node_modules/@scope/pkg/lib/index.js":
                        "// scoped pkg\n",
                      "/home/vcap/app/.store/@scope+pkg@1.0.0/node_modules/@scope/pkg/lib/utils.js":
                        "// scoped utils\n",
                    },
                    symlinks: {
                      "/home/vcap/app/node_modules/@scope/pkg":
                        "../../.store/@scope+pkg@1.0.0/node_modules/@scope/pkg",
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

async function expectSingleTarSsh(paths: CasePaths): Promise<void> {
  const sshLogs = (await readFakeLog(paths.logPath)).filter((entry) => entry.command === "ssh");
  expect(sshLogs).toHaveLength(1);
  const renderedArgs = sshLogs[0]?.args?.join(" ") ?? "";
  expect(renderedArgs).toContain("tar");
  expect(renderedArgs).not.toContain("cat --");
  expect(renderedArgs).not.toContain("ls -la");
}

test("User can download a flat folder with one tar SSH command", async () => {
  const paths = await prepareCase(ROOT_NAME, "flat", createScenario());
  const env = createEnv(paths);
  const outDir = join(paths.workDir, "app");

  const result = await runCli(env, [
    "download-folder",
    ...TARGET_ARGS,
    "--remote",
    "/home/vcap/app",
    "--out",
    outDir,
  ]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("Downloaded");
  expect(result.stdout).toContain("file(s)");
  expect(result.stdout).toContain(outDir);

  const pkgContent = await readFile(join(outDir, "package.json"), "utf8");
  const pkg = JSON.parse(pkgContent) as { readonly name: string };
  expect(pkg.name).toBe("demo-app");
  await expectSingleTarSsh(paths);
});

test("User can recursively download nested subdirectories", async () => {
  const paths = await prepareCase(ROOT_NAME, "recursive", createScenario());
  const env = createEnv(paths);
  const outDir = join(paths.workDir, "src");

  const result = await runCli(env, [
    "download-folder",
    ...TARGET_ARGS,
    "--remote",
    "/home/vcap/app/src",
    "--out",
    outDir,
  ]);

  expect(result.code, result.stderr).toBe(0);
  expect(await readFile(join(outDir, "main.js"), "utf8")).toBe("module.exports = {};\n");
  expect(await readFile(join(outDir, "handlers", "ping.js"), "utf8")).toBe(
    "module.exports = () => {};\n",
  );
});

test("User can resolve folder paths against the default app path", async () => {
  const paths = await prepareCase(ROOT_NAME, "relative", createScenario());
  const env = createEnv(paths);
  const outDir = join(paths.workDir, "src-out");

  const result = await runCli(env, [
    "download-folder",
    ...TARGET_ARGS,
    "--remote",
    "src",
    "--out",
    outDir,
  ]);

  expect(result.code, result.stderr).toBe(0);
  expect(await readFile(join(outDir, "main.js"), "utf8")).toBe("module.exports = {};\n");
});

test("User can download from a custom app path", async () => {
  const paths = await prepareCase(ROOT_NAME, "custom-app-path", createScenario());
  const env = createEnv(paths);
  const outDir = join(paths.workDir, "custom-out");

  const result = await runCli(env, [
    "download-folder",
    ...TARGET_ARGS,
    "--remote",
    "root",
    "--out",
    outDir,
    "--app-path",
    "/custom",
  ]);

  expect(result.code, result.stderr).toBe(0);
  expect(await readFile(join(outDir, "readme.txt"), "utf8")).toBe("custom root file\n");
});

test("User can download folders with spaces and shell metacharacters", async () => {
  const paths = await prepareCase(ROOT_NAME, "special-chars", createScenario());
  const env = createEnv(paths);
  const outDir = join(paths.workDir, "weird-out");

  const result = await runCli(env, [
    "download-folder",
    ...TARGET_ARGS,
    "--remote",
    "/home/vcap/app/weird files",
    "--out",
    outDir,
  ]);

  expect(result.code, result.stderr).toBe(0);
  const content = await readFile(join(outDir, "it's $(safe); name.txt"), "utf8");
  expect(content).toBe("quoted path\n");
});

test("User can download binary files inside a folder", async () => {
  const paths = await prepareCase(ROOT_NAME, "binary", createScenario());
  const env = createEnv(paths);
  const outDir = join(paths.workDir, "app-out");

  const result = await runCli(env, [
    "download-folder",
    ...TARGET_ARGS,
    "--remote",
    "/home/vcap/app",
    "--out",
    outDir,
  ]);

  expect(result.code, result.stderr).toBe(0);
  expect(await readFile(join(outDir, "binary.dat"))).toEqual(
    Buffer.from([0x00, 0xff, 0x01, 0x80]),
  );
});

test("User can create the output directory during folder download", async () => {
  const paths = await prepareCase(ROOT_NAME, "mkdir", createScenario());
  const env = createEnv(paths);
  const outDir = join(paths.workDir, "nested", "new", "dir");

  const result = await runCli(env, [
    "download-folder",
    ...TARGET_ARGS,
    "--remote",
    "/home/vcap/app/src",
    "--out",
    outDir,
  ]);

  expect(result.code, result.stderr).toBe(0);
  expect(await readFile(join(outDir, "main.js"), "utf8")).toBe("module.exports = {};\n");
});

test("User sees a clear error when a remote folder is missing", async () => {
  const paths = await prepareCase(ROOT_NAME, "missing", createScenario());
  const env = createEnv(paths);

  const result = await runCli(env, [
    "download-folder",
    ...TARGET_ARGS,
    "--remote",
    "/does/not/exist",
    "--out",
    join(paths.workDir, "out"),
  ]);

  expect(result.code).not.toBe(0);
  expect(result.stderr).toMatch(/No such file or directory|could not chdir/);
});

test("User can exclude a folder from the tar download", async () => {
  const paths = await prepareCase(ROOT_NAME, "exclude", createFilterScenario());
  const env = createEnv(paths);
  const outDir = join(paths.workDir, "out");

  const result = await runCli(env, [
    "download-folder",
    ...TARGET_ARGS,
    "--remote",
    "/home/vcap/app",
    "--out",
    outDir,
    "--exclude",
    "node_modules",
  ]);

  expect(result.code, result.stderr).toBe(0);
  expect(await readFile(join(outDir, "index.js"), "utf8")).toBe("module.exports = {};\n");
  expect(await readFile(join(outDir, "lib", "helper.js"), "utf8")).toBe("exports.help = true;\n");
  await expect(
    readFile(join(outDir, "node_modules", "other-pkg", "index.js"), "utf8"),
  ).rejects.toThrow();
  await expect(
    readFile(join(outDir, "node_modules", "@vendor", "lib", "index.js"), "utf8"),
  ).rejects.toThrow();
});

test("User can include one subtree under an excluded folder", async () => {
  const paths = await prepareCase(ROOT_NAME, "exclude-include", createFilterScenario());
  const env = createEnv(paths);
  const outDir = join(paths.workDir, "out");

  const result = await runCli(env, [
    "download-folder",
    ...TARGET_ARGS,
    "--remote",
    "/home/vcap/app",
    "--out",
    outDir,
    "--exclude",
    "node_modules",
    "--include",
    "node_modules/@vendor",
  ]);

  expect(result.code, result.stderr).toBe(0);
  expect(await readFile(join(outDir, "index.js"), "utf8")).toBe("module.exports = {};\n");
  expect(await readFile(join(outDir, "lib", "helper.js"), "utf8")).toBe("exports.help = true;\n");
  expect(await readFile(join(outDir, "node_modules", "@vendor", "lib", "index.js"), "utf8"))
    .toBe("// vendor lib\n");
  expect(await readFile(join(outDir, "node_modules", "@vendor", "lib", "utils.js"), "utf8"))
    .toBe("// vendor utils\n");
  await expect(
    readFile(join(outDir, "node_modules", "other-pkg", "index.js"), "utf8"),
  ).rejects.toThrow();
  await expectSingleTarSsh(paths);
});

test("User can pass multiple exclude flags", async () => {
  const paths = await prepareCase(ROOT_NAME, "multi-exclude", createFilterScenario());
  const env = createEnv(paths);
  const outDir = join(paths.workDir, "out");

  const result = await runCli(env, [
    "download-folder",
    ...TARGET_ARGS,
    "--remote",
    "/home/vcap/app",
    "--out",
    outDir,
    "--exclude",
    "node_modules",
    "--exclude",
    "lib",
  ]);

  expect(result.code, result.stderr).toBe(0);
  expect(await readFile(join(outDir, "index.js"), "utf8")).toBe("module.exports = {};\n");
  await expect(readFile(join(outDir, "lib", "helper.js"), "utf8")).rejects.toThrow();
  await expect(
    readFile(join(outDir, "node_modules", "other-pkg", "index.js"), "utf8"),
  ).rejects.toThrow();
});

test("User can download dereferenced package symlinks under an excluded folder", async () => {
  const paths = await prepareCase(ROOT_NAME, "symlink", createSymlinkScenario());
  const env = createEnv(paths);
  const outDir = join(paths.workDir, "out");

  const result = await runCli(env, [
    "download-folder",
    ...TARGET_ARGS,
    "--remote",
    "/home/vcap/app",
    "--out",
    outDir,
    "--exclude",
    "node_modules",
    "--exclude",
    ".store",
    "--include",
    "node_modules/@scope",
  ]);

  expect(result.code, result.stderr).toBe(0);
  expect(await readFile(join(outDir, "index.js"), "utf8")).toBe("module.exports = {};\n");
  expect(await readFile(join(outDir, "node_modules", "@scope", "pkg", "lib", "index.js"), "utf8"))
    .toBe("// scoped pkg\n");
  expect(await readFile(join(outDir, "node_modules", "@scope", "pkg", "lib", "utils.js"), "utf8"))
    .toBe("// scoped utils\n");
  await expectSingleTarSsh(paths);
});
