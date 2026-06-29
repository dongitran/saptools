import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import { buildBaseEnv, PACKAGE_ROOT, runCli, startFakeGraph } from "./helpers.js";
import type { FakeGraphProcess } from "./helpers.js";

const execFileAsync = promisify(execFile);

function scenario() {
  return {
    credentials: {
      tenantId: "demo-tenant",
      clientId: "demo-client",
      clientSecret: "demo-secret",
    },
    site: {
      id: "site-001",
      name: "demo",
      displayName: "Demo Site",
      hostname: "demo.sharepoint.example",
      path: "sites/demo",
      webUrl: "https://demo.sharepoint.example/sites/demo",
    },
    drives: [
      { id: "drive-docs", name: "Documents", driveType: "documentLibrary", webUrl: "https://docs" },
    ],
  } as const;
}

test.describe("saptools-sharepoint-excel fake Graph flow", () => {
  let server: FakeGraphProcess | undefined;
  let env: Readonly<Record<string, string>>;

  test.beforeAll(async () => {
    await execFileAsync("pnpm", ["--filter", "@saptools/sharepoint-excel", "build"], {
      cwd: PACKAGE_ROOT,
      maxBuffer: 32 * 1024 * 1024,
    });
    server = await startFakeGraph(scenario());
    env = {
      ...buildBaseEnv(server.port),
      SHAREPOINT_EXCEL_TENANT_ID: "demo-tenant",
      SHAREPOINT_EXCEL_CLIENT_ID: "demo-client",
      SHAREPOINT_EXCEL_CLIENT_SECRET: "demo-secret",
      SHAREPOINT_EXCEL_SITE: "demo.sharepoint.example/sites/demo",
      SHAREPOINT_EXCEL_DRIVE: "Documents",
      SAPTOOLS_SHAREPOINT_EXCEL_HOME: await mkdtemp(join(tmpdir(), "sharepoint-excel-home-")),
    };
  });

  test.afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  test("User can test auth and list drives", async () => {
    const result = await runCli({ args: ["test", "--json"], env });
    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      readonly site: { readonly displayName: string };
      readonly drives: readonly { readonly name: string }[];
    };
    expect(parsed.site.displayName).toBe("Demo Site");
    expect(parsed.drives[0]?.name).toBe("Documents");
  });

  test("User can create, read, append, update, and add sheets", async () => {
    const path = "Reports/orders.xlsx";
    const create = await runCli({
      args: [
        "create",
        "--json",
        "--path",
        path,
        "--sheet",
        "Orders",
        "--headers",
        "Name,Amount",
        "--rows",
        '[{"Name":"Coffee","Amount":3}]',
      ],
      env,
    });
    expect(create.code, create.stderr).toBe(0);

    const duplicate = await runCli({
      args: ["create", "--json", "--path", path, "--sheet", "Orders"],
      env,
    });
    expect(duplicate.code).not.toBe(0);
    expect(duplicate.stderr).toContain("Refusing to overwrite");

    const append = await runCli({
      args: [
        "append",
        "--json",
        "--path",
        path,
        "--sheet",
        "Orders",
        "--record",
        '{"Name":"Tea","Amount":8}',
      ],
      env,
    });
    expect(append.code, append.stderr).toBe(0);

    const update = await runCli({
      args: [
        "update-cell",
        "--json",
        "--path",
        path,
        "--sheet",
        "Orders",
        "--cell",
        "B2",
        "--value",
        "4",
      ],
      env,
    });
    expect(update.code, update.stderr).toBe(0);

    const addSheet = await runCli({
      args: ["add-sheet", "--json", "--path", path, "--sheet", "Audit", "--headers", "At,Action"],
      env,
    });
    expect(addSheet.code, addSheet.stderr).toBe(0);

    const read = await runCli({ args: ["read", "--json", "--path", path], env });
    expect(read.code, read.stderr).toBe(0);
    const parsed = JSON.parse(read.stdout) as {
      readonly workbook: {
        readonly sheets: readonly {
          readonly name: string;
          readonly rows: readonly (readonly unknown[])[];
        }[];
      };
    };
    const orders = parsed.workbook.sheets.find((sheet) => sheet.name === "Orders");
    const audit = parsed.workbook.sheets.find((sheet) => sheet.name === "Audit");
    expect(orders?.rows).toEqual([
      ["Name", "Amount"],
      ["Coffee", 4],
      ["Tea", 8],
    ]);
    expect(audit?.rows).toEqual([["At", "Action"]]);
  });

  test("missing credentials return a helpful redacted error", async () => {
    const result = await runCli({
      args: ["drives"],
      env: {
        ...buildBaseEnv(server?.port ?? 0),
        SAPTOOLS_SHAREPOINT_EXCEL_HOME: env["SAPTOOLS_SHAREPOINT_EXCEL_HOME"],
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Tenant ID is required");
    expect(result.stderr).not.toContain("demo-secret");
  });
});
