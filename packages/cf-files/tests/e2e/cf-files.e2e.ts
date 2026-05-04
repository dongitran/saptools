import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  type Scenario,
  createEnv,
  prepareCase,
  readFakeLog,
  readJsonFile,
  runCli,
} from "./helpers.js";

const ROOT_NAME = "cf-files-e2e";

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
                    vcapServices: {
                      xsuaa: [
                        {
                          name: "demo-xsuaa",
                          credentials: {
                            clientid: "demo-client",
                            clientsecret: "demo-secret",
                            url: "https://demo.authentication.sap.hana.ondemand.com",
                          },
                        },
                      ],
                      hana: [
                        {
                          name: "demo-db",
                          credentials: {
                            host: "db.example.com",
                            port: 30015,
                            user: "demo-user",
                          },
                        },
                      ],
                    },
                    vcapApplication: {
                      application_id: "demo-guid",
                      application_name: "demo-app",
                    },
                    userProvidedEnv: {
                      destinations: [
                        {
                          name: "example-api",
                          url: "https://example.com",
                          forwardAuthToken: true,
                        },
                      ],
                    },
                    files: {
                      "/home/vcap/app/package.json": JSON.stringify(
                        { name: "demo-app", version: "1.0.0" },
                        null,
                        2,
                      ),
                      "/home/vcap/app/.cdsrc.json": JSON.stringify(
                        { requires: { db: { kind: "hana" } } },
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

test("gen-env writes default-env.json with CF app metadata and destinations", async () => {
  const paths = await prepareCase(ROOT_NAME, "gen-env-happy", createScenario());
  const env = createEnv(paths);
  const outPath = join(paths.workDir, "default-env.json");

  const result = await runCli(env, [
    "gen-env",
    "--region",
    "ap10",
    "--org",
    "demo-org",
    "--space",
    "dev",
    "--app",
    "demo-app",
    "--out",
    outPath,
  ]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("✔ Wrote");
  expect(result.stdout).toContain("default-env.json");

  const payload = await readJsonFile<{
    readonly VCAP_APPLICATION: { readonly application_name: string };
    readonly VCAP_SERVICES: Record<string, unknown>;
    readonly destinations: readonly { readonly name: string }[];
  }>(outPath);
  expect(payload.VCAP_APPLICATION.application_name).toBe("demo-app");
  expect(Array.isArray(payload.VCAP_SERVICES["xsuaa"])).toBe(true);
  expect(payload.VCAP_SERVICES["hana"]).toBeDefined();
  expect(payload.destinations.map((entry) => entry.name)).toEqual(["example-api"]);

  const logs = await readFakeLog(paths.logPath);
  const commands = logs.map((entry) => entry.command);
  expect(commands).toEqual(["api", "auth", "target", "env"]);
  expect(logs.find((entry) => entry.command === "auth")?.args).toEqual([]);
});

test("gen-env fails with clear message when credentials missing", async () => {
  const paths = await prepareCase(ROOT_NAME, "gen-env-no-creds", createScenario());
  const env = { ...createEnv(paths) };
  delete env["SAP_EMAIL"];

  const result = await runCli(env, [
    "gen-env",
    "--region",
    "ap10",
    "--org",
    "demo-org",
    "--space",
    "dev",
    "--app",
    "demo-app",
    "--out",
    join(paths.workDir, "default-env.json"),
  ]);

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("SAP_EMAIL");
});

test("gen-env fails with clear message for unknown region", async () => {
  const paths = await prepareCase(ROOT_NAME, "gen-env-bad-region", createScenario());
  const env = createEnv(paths);

  const result = await runCli(env, [
    "gen-env",
    "--region",
    "xx99",
    "--org",
    "demo-org",
    "--space",
    "dev",
    "--app",
    "demo-app",
    "--out",
    join(paths.workDir, "default-env.json"),
  ]);

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("Unknown CF region: xx99");
});

test("list shows files at the default app path", async () => {
  const paths = await prepareCase(ROOT_NAME, "list-default", createScenario());
  const env = createEnv(paths);

  const result = await runCli(env, [
    "list",
    "--region",
    "ap10",
    "--org",
    "demo-org",
    "--space",
    "dev",
    "--app",
    "demo-app",
  ]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("package.json");
  expect(result.stdout).toContain(".cdsrc.json");
  expect(result.stdout).toContain("binary.dat");
  expect(result.stdout).toContain("src/");
  expect(result.stdout).toContain("weird files/");
});

test("list --json emits a structured list", async () => {
  const paths = await prepareCase(ROOT_NAME, "list-json", createScenario());
  const env = createEnv(paths);

  const result = await runCli(env, [
    "list",
    "--region",
    "ap10",
    "--org",
    "demo-org",
    "--space",
    "dev",
    "--app",
    "demo-app",
    "--json",
  ]);

  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout) as {
    readonly name: string;
    readonly isDirectory: boolean;
  }[];
  const names = parsed.map((e) => e.name).sort();
  expect(names).toEqual([".cdsrc.json", "binary.dat", "package.json", "src", "weird files"]);
  const src = parsed.find((e) => e.name === "src");
  expect(src?.isDirectory).toBe(true);
});

test("list supports a custom --app-path", async () => {
  const paths = await prepareCase(ROOT_NAME, "list-custom-base", createScenario());
  const env = createEnv(paths);

  const result = await runCli(env, [
    "list",
    "--region",
    "ap10",
    "--org",
    "demo-org",
    "--space",
    "dev",
    "--app",
    "demo-app",
    "--app-path",
    "/custom/root",
    "--json",
  ]);

  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout) as { readonly name: string }[];
  expect(parsed.map((e) => e.name)).toEqual(["readme.txt"]);
});

test("list supports an absolute --path overriding --app-path", async () => {
  const paths = await prepareCase(ROOT_NAME, "list-abs-path", createScenario());
  const env = createEnv(paths);

  const result = await runCli(env, [
    "list",
    "--region",
    "ap10",
    "--org",
    "demo-org",
    "--space",
    "dev",
    "--app",
    "demo-app",
    "--path",
    "/home/vcap/app/src",
    "--json",
  ]);

  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout) as { readonly name: string }[];
  expect(parsed.map((e) => e.name).sort()).toEqual(["handlers", "main.js"]);
});

test("download pulls a file from the container to disk", async () => {
  const paths = await prepareCase(ROOT_NAME, "download-happy", createScenario());
  const env = createEnv(paths);
  const outPath = join(paths.workDir, "pkg.json");

  const result = await runCli(env, [
    "download",
    "--region",
    "ap10",
    "--org",
    "demo-org",
    "--space",
    "dev",
    "--app",
    "demo-app",
    "--remote",
    "package.json",
    "--out",
    outPath,
  ]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("✔ Wrote");
  expect(result.stdout).toMatch(/bytes\)/);

  const content = await readFile(outPath, "utf8");
  const parsed = JSON.parse(content) as { readonly name: string };
  expect(parsed.name).toBe("demo-app");
});

test("download accepts an absolute --remote path", async () => {
  const paths = await prepareCase(ROOT_NAME, "download-abs", createScenario());
  const env = createEnv(paths);
  const outPath = join(paths.workDir, "readme.txt");

  const result = await runCli(env, [
    "download",
    "--region",
    "ap10",
    "--org",
    "demo-org",
    "--space",
    "dev",
    "--app",
    "demo-app",
    "--remote",
    "/custom/root/readme.txt",
    "--out",
    outPath,
  ]);

  expect(result.code).toBe(0);
  expect(await readFile(outPath, "utf8")).toBe("custom root file\n");
});

test("download safely handles spaces, quotes, and shell metacharacters in remote paths", async () => {
  const paths = await prepareCase(ROOT_NAME, "download-quoted-path", createScenario());
  const env = createEnv(paths);
  const outPath = join(paths.workDir, "quoted.txt");

  const result = await runCli(env, [
    "download",
    "--region",
    "ap10",
    "--org",
    "demo-org",
    "--space",
    "dev",
    "--app",
    "demo-app",
    "--remote",
    "weird files/it's $(safe); name.txt",
    "--out",
    outPath,
  ]);

  expect(result.code).toBe(0);
  expect(await readFile(outPath, "utf8")).toBe("quoted path\n");

  const logs = await readFakeLog(paths.logPath);
  const sshLog = logs.find((entry) => entry.command === "ssh");
  expect(sshLog?.args?.join(" ")).toContain("cat -- '/home/vcap/app/weird files/it");
});

test("download preserves binary bytes", async () => {
  const paths = await prepareCase(ROOT_NAME, "download-binary", createScenario());
  const env = createEnv(paths);
  const outPath = join(paths.workDir, "binary.dat");

  const result = await runCli(env, [
    "download",
    "--region",
    "ap10",
    "--org",
    "demo-org",
    "--space",
    "dev",
    "--app",
    "demo-app",
    "--remote",
    "binary.dat",
    "--out",
    outPath,
  ]);

  expect(result.code).toBe(0);
  expect(await readFile(outPath)).toEqual(Buffer.from([0x00, 0xff, 0x01, 0x80]));
});

test("download-folder copies a flat directory from the container", async () => {
  const paths = await prepareCase(ROOT_NAME, "download-folder-flat", createScenario());
  const env = createEnv(paths);
  const outDir = join(paths.workDir, "app");

  const result = await runCli(env, [
    "download-folder",
    "--region",
    "ap10",
    "--org",
    "demo-org",
    "--space",
    "dev",
    "--app",
    "demo-app",
    "--remote",
    "/home/vcap/app",
    "--out",
    outDir,
  ]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("✔ Downloaded");
  expect(result.stdout).toContain("file(s)");
  expect(result.stdout).toContain(outDir);

  const pkgContent = await readFile(join(outDir, "package.json"), "utf8");
  const pkg = JSON.parse(pkgContent) as { readonly name: string };
  expect(pkg.name).toBe("demo-app");
});

test("download-folder recursively downloads nested subdirectories", async () => {
  const paths = await prepareCase(ROOT_NAME, "download-folder-recursive", createScenario());
  const env = createEnv(paths);
  const outDir = join(paths.workDir, "src");

  const result = await runCli(env, [
    "download-folder",
    "--region",
    "ap10",
    "--org",
    "demo-org",
    "--space",
    "dev",
    "--app",
    "demo-app",
    "--remote",
    "/home/vcap/app/src",
    "--out",
    outDir,
  ]);

  expect(result.code).toBe(0);

  const mainJs = await readFile(join(outDir, "main.js"), "utf8");
  expect(mainJs).toBe("module.exports = {};\n");

  const pingJs = await readFile(join(outDir, "handlers", "ping.js"), "utf8");
  expect(pingJs).toBe("module.exports = () => {};\n");
});

test("download-folder uses relative --remote resolved against default --app-path", async () => {
  const paths = await prepareCase(ROOT_NAME, "download-folder-relative", createScenario());
  const env = createEnv(paths);
  const outDir = join(paths.workDir, "src-out");

  const result = await runCli(env, [
    "download-folder",
    "--region",
    "ap10",
    "--org",
    "demo-org",
    "--space",
    "dev",
    "--app",
    "demo-app",
    "--remote",
    "src",
    "--out",
    outDir,
  ]);

  expect(result.code).toBe(0);
  expect(await readFile(join(outDir, "main.js"), "utf8")).toBe("module.exports = {};\n");
});

test("download-folder uses a custom --app-path", async () => {
  const paths = await prepareCase(ROOT_NAME, "download-folder-custom-app-path", createScenario());
  const env = createEnv(paths);
  const outDir = join(paths.workDir, "custom-out");

  const result = await runCli(env, [
    "download-folder",
    "--region",
    "ap10",
    "--org",
    "demo-org",
    "--space",
    "dev",
    "--app",
    "demo-app",
    "--remote",
    "root",
    "--out",
    outDir,
    "--app-path",
    "/custom",
  ]);

  expect(result.code).toBe(0);
  expect(await readFile(join(outDir, "readme.txt"), "utf8")).toBe("custom root file\n");
});

test("download-folder handles directory names with spaces and special characters", async () => {
  const paths = await prepareCase(ROOT_NAME, "download-folder-special-chars", createScenario());
  const env = createEnv(paths);
  const outDir = join(paths.workDir, "weird-out");

  const result = await runCli(env, [
    "download-folder",
    "--region",
    "ap10",
    "--org",
    "demo-org",
    "--space",
    "dev",
    "--app",
    "demo-app",
    "--remote",
    "/home/vcap/app/weird files",
    "--out",
    outDir,
  ]);

  expect(result.code).toBe(0);
  const content = await readFile(join(outDir, "it's $(safe); name.txt"), "utf8");
  expect(content).toBe("quoted path\n");
});

test("download-folder preserves binary file content", async () => {
  const paths = await prepareCase(ROOT_NAME, "download-folder-binary", createScenario());
  const env = createEnv(paths);
  const outDir = join(paths.workDir, "app-out");

  const result = await runCli(env, [
    "download-folder",
    "--region",
    "ap10",
    "--org",
    "demo-org",
    "--space",
    "dev",
    "--app",
    "demo-app",
    "--remote",
    "/home/vcap/app",
    "--out",
    outDir,
  ]);

  expect(result.code).toBe(0);
  expect(await readFile(join(outDir, "binary.dat"))).toEqual(
    Buffer.from([0x00, 0xff, 0x01, 0x80]),
  );
});

test("download-folder creates the output directory if it does not exist", async () => {
  const paths = await prepareCase(ROOT_NAME, "download-folder-mkdir", createScenario());
  const env = createEnv(paths);
  const outDir = join(paths.workDir, "nested", "new", "dir");

  const result = await runCli(env, [
    "download-folder",
    "--region",
    "ap10",
    "--org",
    "demo-org",
    "--space",
    "dev",
    "--app",
    "demo-app",
    "--remote",
    "/home/vcap/app/src",
    "--out",
    outDir,
  ]);

  expect(result.code).toBe(0);
  expect(await readFile(join(outDir, "main.js"), "utf8")).toBe("module.exports = {};\n");
});

test("download-folder fails with a clear message for a missing remote path", async () => {
  const paths = await prepareCase(ROOT_NAME, "download-folder-missing", createScenario());
  const env = createEnv(paths);

  const result = await runCli(env, [
    "download-folder",
    "--region",
    "ap10",
    "--org",
    "demo-org",
    "--space",
    "dev",
    "--app",
    "demo-app",
    "--remote",
    "/does/not/exist",
    "--out",
    join(paths.workDir, "out"),
  ]);

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("No such file or directory");
});

test("download fails with a clear message for missing file", async () => {
  const paths = await prepareCase(ROOT_NAME, "download-missing", createScenario());
  const env = createEnv(paths);

  const result = await runCli(env, [
    "download",
    "--region",
    "ap10",
    "--org",
    "demo-org",
    "--space",
    "dev",
    "--app",
    "demo-app",
    "--remote",
    "does-not-exist.txt",
    "--out",
    join(paths.workDir, "out.txt"),
  ]);

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("No such file or directory");
});
