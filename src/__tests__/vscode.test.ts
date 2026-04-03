import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { toSqlToolsConnection, updateVscodeConnections } from "../vscode.js";
import type { AppHanaEntry } from "../types.js";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Fixtures ─────────────────────────────────────────────────────────

const SAMPLE_ENTRY: AppHanaEntry = {
  app: "demoapp-db-prd",
  org: "acmecorp-dev-democorp",
  space: "app",
  region: "ap11",
  hana: {
    host: "feb62cb7-150e-4d6a-aaf7-c332e7cc5d02.hana.prod-ap11.hanacloud.ondemand.com",
    port: "443",
    user: "demoapp_PRD_RT",
    password: "secret-password",
    schema: "demoapp_PRD",
    hdiUser: "demoapp_PRD_DT",
    hdiPassword: "secret-hdi-password",
    url: "jdbc:sap://feb62cb7...?encrypt=true",
    databaseId: "feb62cb7-150e-4d6a-aaf7-c332e7cc5d02",
    certificate: "-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----",
  },
};

const SECOND_ENTRY: AppHanaEntry = {
  ...SAMPLE_ENTRY,
  app: "demoapp-db-config",
  hana: {
    ...SAMPLE_ENTRY.hana,
    user: "demoapp_CONFIG_RT",
    schema: "demoapp_CONFIG",
  },
};

// ── Unit: toSqlToolsConnection ────────────────────────────────────────

describe("toSqlToolsConnection", () => {
  it("maps host to server field", () => {
    const conn = toSqlToolsConnection(SAMPLE_ENTRY);

    expect(conn.server).toBe(SAMPLE_ENTRY.hana.host);
  });

  it("converts port from string to number", () => {
    const conn = toSqlToolsConnection(SAMPLE_ENTRY);

    expect(conn.port).toBe(443);
    expect(typeof conn.port).toBe("number");
  });

  it("maps user to username field", () => {
    const conn = toSqlToolsConnection(SAMPLE_ENTRY);

    expect(conn.username).toBe(SAMPLE_ENTRY.hana.user);
  });

  it("maps schema to database field", () => {
    const conn = toSqlToolsConnection(SAMPLE_ENTRY);

    expect(conn.database).toBe(SAMPLE_ENTRY.hana.schema);
  });

  it("includes app name and region in connection name", () => {
    const conn = toSqlToolsConnection(SAMPLE_ENTRY);

    expect(conn.name).toBe("demoapp-db-prd (ap11)");
  });

  it("sets driver to SAPHana", () => {
    expect(toSqlToolsConnection(SAMPLE_ENTRY).driver).toBe("SAPHana");
  });

  it("sets hanaOptions with encryption enabled", () => {
    const conn = toSqlToolsConnection(SAMPLE_ENTRY);

    expect(conn.hanaOptions.encrypt).toBe(true);
    expect(conn.hanaOptions.sslValidateCertificate).toBe(true);
    expect(conn.hanaOptions.sslCryptoProvider).toBe("openssl");
  });

  it("sets connectionTimeout to 30 and previewLimit to 50", () => {
    const conn = toSqlToolsConnection(SAMPLE_ENTRY);

    expect(conn.connectionTimeout).toBe(30);
    expect(conn.previewLimit).toBe(50);
  });
});

// ── Integration: updateVscodeConnections ────────────────────────────

describe("updateVscodeConnections", () => {
  let tmpDir: string;
  let vscodeDir: string;
  let settingsPath: string;

  beforeEach(async () => {
    // Create a fresh temp workspace for each test
    tmpDir = join(tmpdir(), `sap-cli-vscode-test-${Date.now().toString()}`);
    vscodeDir = join(tmpDir, ".vscode");
    settingsPath = join(vscodeDir, "settings.json");
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates .vscode/settings.json when neither dir nor file exist", async () => {
    const written = await updateVscodeConnections([SAMPLE_ENTRY], tmpDir);

    expect(existsSync(settingsPath)).toBe(true);
    expect(written).toBe(settingsPath);
  });

  it("writes correct sqltools.connections array", async () => {
    await updateVscodeConnections([SAMPLE_ENTRY], tmpDir);

    const raw = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const connections = settings["sqltools.connections"] as unknown[];

    expect(Array.isArray(connections)).toBe(true);
    expect(connections).toHaveLength(1);
  });

  it("each connection has correct mapped fields", async () => {
    await updateVscodeConnections([SAMPLE_ENTRY], tmpDir);

    const raw = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const conn = (settings["sqltools.connections"] as Record<string, unknown>[])[0];

    expect(conn).toBeDefined();
    expect(conn?.["server"]).toBe(SAMPLE_ENTRY.hana.host);
    expect(conn?.["port"]).toBe(443);
    expect(conn?.["username"]).toBe(SAMPLE_ENTRY.hana.user);
    expect(conn?.["database"]).toBe(SAMPLE_ENTRY.hana.schema);
    expect(conn?.["name"]).toBe("demoapp-db-prd (ap11)");
  });

  it("adds sqltools.useNodeRuntime: true", async () => {
    await updateVscodeConnections([SAMPLE_ENTRY], tmpDir);

    const raw = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;

    expect(settings["sqltools.useNodeRuntime"]).toBe(true);
  });

  it("preserves existing unrelated settings when file already exists", async () => {
    // Pre-populate with an existing setting
    await mkdir(vscodeDir, { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({ "workbench.iconTheme": "material-icon-theme", "editor.fontSize": 14 }),
    );

    await updateVscodeConnections([SAMPLE_ENTRY], tmpDir);

    const raw = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;

    expect(settings["workbench.iconTheme"]).toBe("material-icon-theme");
    expect(settings["editor.fontSize"]).toBe(14);
  });

  it("overwrites previous sqltools.connections completely", async () => {
    // First run: 1 app
    await updateVscodeConnections([SAMPLE_ENTRY], tmpDir);

    // Second run: 2 apps — should replace, not append
    await updateVscodeConnections([SAMPLE_ENTRY, SECOND_ENTRY], tmpDir);

    const raw = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const connections = settings["sqltools.connections"] as unknown[];

    expect(connections).toHaveLength(2);
  });

  it("handles multiple entries correctly", async () => {
    await updateVscodeConnections([SAMPLE_ENTRY, SECOND_ENTRY], tmpDir);

    const raw = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const connections = settings["sqltools.connections"] as Record<string, unknown>[];

    expect(connections[0]?.["name"]).toBe("demoapp-db-prd (ap11)");
    expect(connections[1]?.["name"]).toBe("demoapp-db-config (ap11)");
  });

  it("works when .vscode dir already exists but settings.json does not", async () => {
    await mkdir(vscodeDir, { recursive: true });

    await expect(updateVscodeConnections([SAMPLE_ENTRY], tmpDir)).resolves.toBe(settingsPath);
    expect(existsSync(settingsPath)).toBe(true);
  });

  it("outputs valid JSON with 4-space indentation", async () => {
    await updateVscodeConnections([SAMPLE_ENTRY], tmpDir);

    const raw = await readFile(settingsPath, "utf-8");

    // 4-space indent means lines start with "    " for top-level keys
    expect(raw).toMatch(/^\{\n {4}"/m);
  });

  it("handles malformed settings.json gracefully (replaces with new)", async () => {
    await mkdir(vscodeDir, { recursive: true });
    await writeFile(settingsPath, "{ this is not valid json !!!", "utf-8");

    await updateVscodeConnections([SAMPLE_ENTRY], tmpDir);

    const raw = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;

    // Malformed file should be replaced entirely — connections still written
    expect(settings["sqltools.connections"]).toBeDefined();
    expect(settings["sqltools.useNodeRuntime"]).toBe(true);
  });

  it("uses process.cwd() when no workspaceRoot is given", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);

    try {
      const result = await updateVscodeConnections([SAMPLE_ENTRY]);

      expect(result).toContain(".vscode");
      expect(result).toContain("settings.json");
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
