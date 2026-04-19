import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildEntryFromVcap,
  exportFromFile,
  exportFromVcap,
} from "../../src/export.js";
import {
  SQLTOOLS_CONNECTIONS_KEY,
  VSCODE_SETTINGS_REL_PATH,
} from "../../src/sqltools.js";
import type { SqlToolsConnection } from "../../src/types.js";

const CREDENTIALS = {
  host: "h",
  port: "443",
  user: "u",
  password: "p",
  schema: "s",
  hdi_user: "hu",
  hdi_password: "hp",
  url: "jdbc:sap://h:443",
  database_id: "d",
  certificate: "c",
};

function vcapJson(): string {
  return JSON.stringify({ hana: [{ credentials: CREDENTIALS }] });
}

const CONTEXT = { app: "svc", org: "acme", space: "dev", region: "eu10" } as const;

describe("buildEntryFromVcap", () => {
  it("builds an entry from a valid payload", () => {
    const entry = buildEntryFromVcap({ vcapServices: vcapJson(), context: CONTEXT });
    expect(entry?.app).toBe("svc");
    expect(entry?.hana.hdiUser).toBe("hu");
  });

  it("returns null when VCAP_SERVICES has no hana binding", () => {
    const entry = buildEntryFromVcap({
      vcapServices: JSON.stringify({ xsuaa: [] }),
      context: CONTEXT,
    });
    expect(entry).toBeNull();
  });

  it("returns null when the hana array is empty", () => {
    const entry = buildEntryFromVcap({
      vcapServices: JSON.stringify({ hana: [] }),
      context: CONTEXT,
    });
    expect(entry).toBeNull();
  });
});

describe("exportFromVcap / exportFromFile", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "sqltools-export-"));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("writes the settings file and the credentials backup by default", async () => {
    const result = await exportFromVcap(
      { vcapServices: vcapJson(), context: CONTEXT },
      { workspaceRoot },
    );
    expect(result.connectionCount).toBe(1);
    expect(result.credentialsPath?.endsWith("hana-credentials.json")).toBe(true);

    const settings = JSON.parse(
      await readFile(join(workspaceRoot, VSCODE_SETTINGS_REL_PATH), "utf-8"),
    ) as Record<string, unknown>;
    const connections = settings[SQLTOOLS_CONNECTIONS_KEY] as readonly SqlToolsConnection[];
    expect(connections[0]?.name).toBe("svc (eu10)");
  });

  it("skips the credentials file when writeCredentialsFile=false", async () => {
    const result = await exportFromVcap(
      { vcapServices: vcapJson(), context: CONTEXT },
      { workspaceRoot, writeCredentialsFile: false },
    );
    expect(result.credentialsPath).toBeUndefined();
  });

  it("throws a descriptive error when no hana binding exists", async () => {
    await expect(
      exportFromVcap(
        { vcapServices: JSON.stringify({}), context: CONTEXT },
        { workspaceRoot },
      ),
    ).rejects.toThrow(/No HANA binding found/);
  });

  it("exportFromFile reads from disk and delegates to exportFromVcap", async () => {
    const vcapPath = join(workspaceRoot, "vcap.json");
    await writeFile(vcapPath, vcapJson(), "utf-8");
    const result = await exportFromFile(
      { filePath: vcapPath, context: CONTEXT },
      { workspaceRoot, writeCredentialsFile: false },
    );
    expect(result.connectionCount).toBe(1);
  });
});
