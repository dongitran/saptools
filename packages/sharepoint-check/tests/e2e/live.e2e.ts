import process from "node:process";

import { expect, test } from "@playwright/test";

import { runCli } from "./helpers.js";

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

test.describe("live sharepoint-check against a real tenant", () => {
  const tenantId = readEnv("SHAREPOINT_TENANT_ID");
  const clientId = readEnv("SHAREPOINT_CLIENT_ID");
  const clientSecret = readEnv("SHAREPOINT_CLIENT_SECRET");
  const site = readEnv("SHAREPOINT_SITE");

  test.skip(
    !tenantId || !clientId || !clientSecret || !site,
    "SHAREPOINT_TENANT_ID, SHAREPOINT_CLIENT_ID, SHAREPOINT_CLIENT_SECRET, SHAREPOINT_SITE must be set",
  );

  function liveEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {
      ...process.env,
    };
    delete env["SHAREPOINT_AUTH_BASE"];
    delete env["SHAREPOINT_GRAPH_BASE"];
    return env;
  }

  test("test: authenticates and resolves the configured site", async () => {
    const result = await runCli({
      args: ["test", "--json"],
      env: liveEnv(),
    });
    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      readonly site: { readonly id: string };
      readonly token: { readonly tokenType: string };
    };
    expect(parsed.token.tokenType).toMatch(/Bearer/i);
    expect(parsed.site.id.length).toBeGreaterThan(0);
  });

  test("drives: returns at least one document library", async () => {
    const result = await runCli({
      args: ["drives", "--json"],
      env: liveEnv(),
    });
    expect(result.code, result.stderr).toBe(0);
    const drives = JSON.parse(result.stdout) as { readonly id: string; readonly name: string }[];
    expect(Array.isArray(drives)).toBe(true);
    expect(drives.length).toBeGreaterThan(0);
  });

  test("tree: walks the root of the first drive without errors", async () => {
    const result = await runCli({
      args: ["tree", "--json", "--depth", "1"],
      env: liveEnv(),
    });
    expect(result.code, result.stderr).toBe(0);
    const tree = JSON.parse(result.stdout) as { readonly folderCount: number; readonly fileCount: number };
    expect(typeof tree.folderCount).toBe("number");
    expect(typeof tree.fileCount).toBe("number");
  });
});
