import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONNECTION_TIMEOUT,
  DRIVER,
  HANA_OPTIONS,
  PREVIEW_LIMIT,
  SQLTOOLS_CONNECTIONS_KEY,
  SQLTOOLS_USE_NODE_RUNTIME_KEY,
  VSCODE_SETTINGS_REL_PATH,
  toSqlToolsConnection,
  updateVscodeConnections,
} from "../../src/sqltools.js";
import type { AppHanaEntry, SqlToolsConnection } from "../../src/types.js";

function makeEntry(overrides: Partial<AppHanaEntry> = {}): AppHanaEntry {
  return {
    app: "invoice-service",
    org: "acme",
    space: "dev",
    region: "eu10",
    hana: {
      host: "host.hana.example.com",
      port: "443",
      user: "USER_1",
      password: "pw",
      schema: "SCHEMA_1",
      hdiUser: "HDI_USER",
      hdiPassword: "HDI_PASS",
      url: "jdbc:sap://host.hana.example.com:443",
      databaseId: "DB123",
      certificate: "cert",
    },
    ...overrides,
  };
}

describe("toSqlToolsConnection", () => {
  it("maps an entry to the SQLTools connection shape", () => {
    const connection = toSqlToolsConnection(makeEntry());
    expect(connection.name).toBe("invoice-service (eu10)");
    expect(connection.driver).toBe(DRIVER);
    expect(connection.server).toBe("host.hana.example.com");
    expect(connection.port).toBe(443);
    expect(connection.username).toBe("USER_1");
    expect(connection.password).toBe("pw");
    expect(connection.database).toBe("SCHEMA_1");
    expect(connection.connectionTimeout).toBe(CONNECTION_TIMEOUT);
    expect(connection.previewLimit).toBe(PREVIEW_LIMIT);
    expect(connection.hanaOptions).toEqual(HANA_OPTIONS);
  });

  it("throws when the binding port is not a positive integer", () => {
    expect(() =>
      toSqlToolsConnection(
        makeEntry({ hana: { ...makeEntry().hana, port: "not-a-number" } }),
      ),
    ).toThrow(/Invalid HANA port/);
  });

  it("throws when the binding port is zero", () => {
    expect(() =>
      toSqlToolsConnection(makeEntry({ hana: { ...makeEntry().hana, port: "0" } })),
    ).toThrow(/Invalid HANA port/);
  });
});

describe("updateVscodeConnections", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "sqltools-unit-"));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  async function readSettings(): Promise<Record<string, unknown>> {
    const settingsPath = join(workspaceRoot, VSCODE_SETTINGS_REL_PATH);
    const raw = await readFile(settingsPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  }

  it("creates .vscode/settings.json when none exists", async () => {
    const result = await updateVscodeConnections([makeEntry()], { workspaceRoot });
    expect(result.connectionCount).toBe(1);
    expect(result.settingsPath.endsWith(VSCODE_SETTINGS_REL_PATH)).toBe(true);

    const settings = await readSettings();
    expect(settings[SQLTOOLS_USE_NODE_RUNTIME_KEY]).toBe(true);
    const connections = settings[SQLTOOLS_CONNECTIONS_KEY] as readonly SqlToolsConnection[];
    expect(connections.length).toBe(1);
    expect(connections[0]?.name).toBe("invoice-service (eu10)");
  });

  it("preserves unrelated keys in an existing settings.json", async () => {
    const settingsPath = join(workspaceRoot, VSCODE_SETTINGS_REL_PATH);
    await writeFile(
      settingsPath.replace(/settings\.json$/u, ""),
      "", // ensure parent exists via updateVscodeConnections
    ).catch(() => undefined);
    // Write a prior settings file with unrelated keys
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(workspaceRoot, ".vscode"), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({ "editor.tabSize": 2, "editor.fontSize": 13 }, null, 2),
      "utf-8",
    );

    await updateVscodeConnections([makeEntry()], { workspaceRoot });
    const settings = await readSettings();
    expect(settings["editor.tabSize"]).toBe(2);
    expect(settings["editor.fontSize"]).toBe(13);
    expect(settings[SQLTOOLS_USE_NODE_RUNTIME_KEY]).toBe(true);
    expect(Array.isArray(settings[SQLTOOLS_CONNECTIONS_KEY])).toBe(true);
  });

  it("overwrites existing sqltools.connections by default", async () => {
    await updateVscodeConnections([makeEntry({ app: "first" })], { workspaceRoot });
    await updateVscodeConnections([makeEntry({ app: "second" })], { workspaceRoot });
    const settings = await readSettings();
    const connections = settings[SQLTOOLS_CONNECTIONS_KEY] as readonly SqlToolsConnection[];
    expect(connections.length).toBe(1);
    expect(connections[0]?.name).toBe("second (eu10)");
  });

  it("merges with existing connections when merge=true", async () => {
    await updateVscodeConnections([makeEntry({ app: "first" })], { workspaceRoot });
    await updateVscodeConnections([makeEntry({ app: "second" })], {
      workspaceRoot,
      merge: true,
    });

    const settings = await readSettings();
    const connections = settings[SQLTOOLS_CONNECTIONS_KEY] as readonly SqlToolsConnection[];
    expect(connections.map((c) => c.name)).toEqual(["first (eu10)", "second (eu10)"]);
  });

  it("merge replaces an entry with the same name", async () => {
    await updateVscodeConnections([makeEntry({ app: "shared" })], { workspaceRoot });
    const updatedEntry = makeEntry({
      app: "shared",
      hana: { ...makeEntry().hana, host: "new-host.example.com" },
    });
    await updateVscodeConnections([updatedEntry], { workspaceRoot, merge: true });

    const settings = await readSettings();
    const connections = settings[SQLTOOLS_CONNECTIONS_KEY] as readonly SqlToolsConnection[];
    expect(connections.length).toBe(1);
    expect(connections[0]?.server).toBe("new-host.example.com");
  });

  it("treats an unparseable existing settings.json as empty", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(workspaceRoot, ".vscode"), { recursive: true });
    await writeFile(
      join(workspaceRoot, VSCODE_SETTINGS_REL_PATH),
      "{ not: valid json",
      "utf-8",
    );
    await updateVscodeConnections([makeEntry()], { workspaceRoot });
    const settings = await readSettings();
    expect(Array.isArray(settings[SQLTOOLS_CONNECTIONS_KEY])).toBe(true);
  });
});
