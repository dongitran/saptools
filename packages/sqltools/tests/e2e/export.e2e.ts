import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { expect, test } from "@playwright/test";

import type { AppHanaEntry, SqlToolsConnection } from "../../src/types.js";

import {
  CLI_PATH,
  FAKE_CF_BIN,
  VALID_VCAP,
  prepareCase,
  runCli,
  writeJsonFile,
} from "./helpers.js";

const ROOT_NAME = "sqltools-export-e2e";
const SHARED_ARGS = [
  "--app",
  "invoice-service",
  "--region",
  "eu10",
  "--org",
  "acme",
  "--space",
  "dev",
] as const;

async function readSettings(path: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

test.describe("CLI export flows", () => {
  test.beforeAll(() => {
    expect(existsSync(CLI_PATH), `CLI must be built at ${CLI_PATH}`).toBe(true);
    expect(existsSync(FAKE_CF_BIN), `Fake cf fixture must exist at ${FAKE_CF_BIN}`).toBe(true);
  });

  test("from-file writes SQLTools connections and backup JSON", async () => {
    const paths = await prepareCase(ROOT_NAME, "from-file");
    await writeJsonFile(paths.vcapPath, VALID_VCAP);

    const result = await runCli([
      "from-file",
      "--input",
      paths.vcapPath,
      "--cwd",
      paths.workspaceRoot,
      ...SHARED_ARGS,
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Updated SQLTools connections (1)");
    expect(result.stdout).toContain(paths.settingsPath);
    expect(result.stdout).toContain(paths.credentialsPath);

    const settings = await readSettings(paths.settingsPath);
    expect(settings["sqltools.useNodeRuntime"]).toBe(true);
    const connections = settings["sqltools.connections"] as readonly SqlToolsConnection[];
    expect(connections.length).toBe(1);
    expect(connections[0]?.name).toBe("invoice-service (eu10)");
    expect(connections[0]?.port).toBe(443);

    const backup = JSON.parse(await readFile(paths.credentialsPath, "utf-8")) as
      readonly AppHanaEntry[];
    expect(backup[0]?.hana.hdiUser).toBe("HDI_USER");
  });

  test("from-stdin reads VCAP from stdin and preserves unrelated settings", async () => {
    const paths = await prepareCase(ROOT_NAME, "from-stdin");
    const existingSettings = { "editor.tabSize": 2, "editor.fontSize": 13 };
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dirname(paths.settingsPath), { recursive: true });
    await writeFile(
      paths.settingsPath,
      JSON.stringify(existingSettings, null, 2),
      "utf-8",
    );

    const result = await runCli(
      [
        "from-stdin",
        "--cwd",
        paths.workspaceRoot,
        "--no-credentials-file",
        ...SHARED_ARGS,
      ],
      { stdin: JSON.stringify(VALID_VCAP) },
    );

    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(paths.credentialsPath)).toBe(false);

    const settings = await readSettings(paths.settingsPath);
    expect(settings["editor.tabSize"]).toBe(2);
    expect(settings["editor.fontSize"]).toBe(13);
    const connections = settings["sqltools.connections"] as readonly SqlToolsConnection[];
    expect(connections[0]?.name).toBe("invoice-service (eu10)");
  });

  test("from-cf shells out via CF_SYNC_CF_BIN and writes the connection", async () => {
    const paths = await prepareCase(ROOT_NAME, "from-cf");
    await writeJsonFile(paths.scenarioPath, { apps: { "invoice-service": VALID_VCAP } });

    const result = await runCli(
      [
        "from-cf",
        "--cwd",
        paths.workspaceRoot,
        "--no-credentials-file",
        ...SHARED_ARGS,
      ],
      {
        env: {
          CF_SYNC_CF_BIN: FAKE_CF_BIN,
          SQLTOOLS_FAKE_CF_SCENARIO: paths.scenarioPath,
        },
      },
    );

    expect(result.code, result.stderr).toBe(0);
    const settings = await readSettings(paths.settingsPath);
    const connections = settings["sqltools.connections"] as readonly SqlToolsConnection[];
    expect(connections[0]?.server).toBe("host.hana.example.com");
  });

  test("from-file exits non-zero when VCAP has no hana binding", async () => {
    const paths = await prepareCase(ROOT_NAME, "no-binding");
    await writeJsonFile(paths.vcapPath, { xsuaa: [] });

    const result = await runCli([
      "from-file",
      "--input",
      paths.vcapPath,
      "--cwd",
      paths.workspaceRoot,
      ...SHARED_ARGS,
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("No HANA binding found");
    expect(existsSync(paths.settingsPath)).toBe(false);
  });

  test("merge mode preserves an unrelated existing connection", async () => {
    const paths = await prepareCase(ROOT_NAME, "merge");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dirname(paths.settingsPath), { recursive: true });
    const existing: SqlToolsConnection = {
      name: "legacy (eu10)",
      driver: "SAPHana",
      server: "legacy.example.com",
      port: 443,
      username: "LEG",
      password: "pw",
      database: "LEG",
      connectionTimeout: 30,
      previewLimit: 50,
      hanaOptions: {
        encrypt: true,
        sslValidateCertificate: true,
        sslCryptoProvider: "openssl",
      },
    };
    await writeFile(
      paths.settingsPath,
      JSON.stringify({ "sqltools.connections": [existing] }, null, 2),
      "utf-8",
    );

    await writeJsonFile(paths.vcapPath, VALID_VCAP);
    const result = await runCli([
      "from-file",
      "--input",
      paths.vcapPath,
      "--cwd",
      paths.workspaceRoot,
      "--merge",
      ...SHARED_ARGS,
    ]);

    expect(result.code, result.stderr).toBe(0);
    const settings = await readSettings(paths.settingsPath);
    const connections = settings["sqltools.connections"] as readonly SqlToolsConnection[];
    expect(connections.map((c) => c.name).sort()).toEqual(
      ["invoice-service (eu10)", "legacy (eu10)"].sort(),
    );
  });

  test("convert prints a SQLTools connection JSON without writing files", async () => {
    const paths = await prepareCase(ROOT_NAME, "convert");
    await writeJsonFile(paths.vcapPath, VALID_VCAP);

    const result = await runCli([
      "convert",
      "--input",
      paths.vcapPath,
      "--app",
      "invoice-service",
      "--region",
      "eu10",
      "--org",
      "acme",
      "--space",
      "dev",
    ]);

    expect(result.code, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout) as SqlToolsConnection;
    expect(payload.name).toBe("invoice-service (eu10)");
    expect(payload.port).toBe(443);
    expect(existsSync(paths.settingsPath)).toBe(false);
    expect(existsSync(paths.credentialsPath)).toBe(false);
  });
});
