import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  fakeCfTracePath,
  fakeTracePath,
  readBackupFiles,
  readFakeCfTraceEntries,
  readFakeTraceEntries,
  readHistoryEntries,
  runCli,
  setupFakeCfBin,
} from "./helpers.js";

const SELECTOR = "eu10/example-org/space-demo/app-demo";
const BACKUP_CSV = "ID,NAME\r\n1,sample-row\r\n2,second-row";
const COMPLEX_UPDATE_SQL = [
  "/* complex update coverage ? */",
  'UpDaTe "ORDER? SET" AS O',
  "SeT NOTE = ?, -- ignored ? WHERE SET",
  '    TOTAL = (SELECT COUNT(*) FROM "ITEM? WHERE" I WHERE I.ORDER_ID = O.ID AND I.STATE = ?),',
  "    LABEL = 'literal ? where SET' /* ignored ? WHERE */",
  'wHeRe O."ID?" = ? AND O.STATUS IN (?, ?);',
].join("\n");
const COMPLEX_UPDATE_SELECT =
  'SELECT * FROM "ORDER? SET" AS O WHERE O."ID?" = ? AND O.STATUS IN (?, ?)';
const COMPLEX_DELETE_SQL = [
  "/* complex delete coverage ? */",
  'DeLeTe FrOm "APP_SCHEMA"."ORDER? WHERE"',
  'wHeRe "STATUS?" = ?',
  '  AND "ID" IN (',
  '    SeLeCt "ORDER_ID" FrOm "ORDER? ITEMS" WhErE "TYPE?" = ?',
  "  ) -- ignored ? WHERE DELETE",
  "  AND \"NOTE?\" <> 'literal ? delete from where' /* ignored ? WHERE */;",
].join("\n");
const COMPLEX_DELETE_SELECT = [
  'SELECT * FROM "APP_SCHEMA"."ORDER? WHERE" WHERE "STATUS?" = ?',
  '  AND "ID" IN (',
  '    SeLeCt "ORDER_ID" FrOm "ORDER? ITEMS" WhErE "TYPE?" = ?',
  "  ) -- ignored ? WHERE DELETE",
  "  AND \"NOTE?\" <> 'literal ? delete from where' /* ignored ? WHERE */",
].join("\n");

interface FakeEnvOptions {
  readonly trace?: boolean;
  readonly failStatement?: "select" | "dml";
  readonly failCatalogOnce?: boolean;
  readonly apiEndpoint?: string;
  readonly directAuthFail?: boolean;
}

let home: string;
let fakeBinDir: string;

test.beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cf-hana-e2e-"));
  fakeBinDir = await setupFakeCfBin(home);
});

test.afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function fakeEnv(options: FakeEnvOptions = {}): Record<string, string> {
  const path = `${fakeBinDir}:${process.env['PATH'] ?? ""}`;
  return {
    HOME: home,
    CF_HANA_DRIVER: "fake",
    PATH: path,
    SAP_EMAIL: "user@example.com",
    SAP_PASSWORD: "secret",
    CF_HANA_FAKE_CF_TRACE_FILE: fakeCfTracePath(home),
    ...(options.trace ? { CF_HANA_FAKE_TRACE_FILE: fakeTracePath(home) } : {}),
    ...(options.failStatement === undefined
      ? {}
      : { CF_HANA_FAKE_FAIL_STATEMENT: options.failStatement }),
    ...(options.failCatalogOnce === true ? { CF_HANA_FAKE_FAIL_CATALOG_ONCE: "1" } : {}),
    ...(options.apiEndpoint === undefined ? {} : { CF_HANA_FAKE_CF_API_ENDPOINT: options.apiEndpoint }),
    ...(options.directAuthFail === true ? { CF_HANA_FAKE_CF_DIRECT_AUTH_FAIL: "1" } : {}),
  };
}

test("User can view help that lists the commands", async () => {
  const result = await runCli(["--help"], fakeEnv());
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("query");
  expect(result.stdout).toContain("tables");
});

test("User can view the version", async () => {
  const result = await runCli(["--version"], fakeEnv());
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("0.4.0");
});

test("User can inspect resolved connection metadata", async () => {
  const result = await runCli(["info", SELECTOR], fakeEnv());
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("APP_SCHEMA");
  expect(result.stdout).toContain("app-demo");
});

test("User can run a query and print compact CSV", async () => {
  const result = await runCli(["query", SELECTOR, "SELECT 1 FROM DUMMY"], fakeEnv());
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("1\r\n1");
});


test("Bare current-session commands use direct cf env on eu10-005 without isolated auth", async () => {
  const commands: readonly (readonly string[])[] = [
    ["info", "app-demo", "--read-only"],
    ["ping", "app-demo", "--read-only"],
    ["query", "app-demo", "SELECT 1 FROM DUMMY", "--read-only"],
    ["tables", "app-demo", "--read-only"],
    ["columns", "app-demo", "APP_SCHEMA.EXISTING_TABLE", "--read-only"],
    ["count", "app-demo", "APP_SCHEMA.EXISTING_TABLE", "--read-only"],
  ];

  for (const args of commands) {
    const result = await runCli(args, fakeEnv());
    expect(result.exitCode, `${args.join(" ")} stderr=${result.stderr}`).toBe(0);
    expect(result.stdout).not.toContain("secret");
    expect(result.stderr).not.toContain("secret");
  }

  const traces = await readFakeCfTraceEntries(home);
  expect(traces.filter((entry) => entry.kind === "target-read")).toHaveLength(commands.length * 2);
  expect(traces.filter((entry) => entry.kind === "env" && entry.cfHome === "current")).toHaveLength(commands.length);
  expect(traces.some((entry) => entry.kind === "api" || entry.kind === "auth" || entry.kind === "target-space")).toBe(false);
});

test("Explicit indexed and China selectors use isolated live auth without leaking secrets", async () => {
  const indexed = await runCli(["info", "eu10-005/example-org/space-demo/app-demo", "--read-only"], fakeEnv());
  expect(indexed.exitCode).toBe(0);
  const eu20 = await runCli(["ping", "eu20-001/example-org/space-demo/app-demo", "--read-only"], fakeEnv());
  expect(eu20.exitCode).toBe(0);
  const china = await runCli(["info", "cn40/example-org/space-demo/app-demo", "--read-only"], fakeEnv());
  expect(china.exitCode).toBe(0);

  const rawTrace = await readFile(fakeCfTracePath(home), "utf8");
  expect(rawTrace).toContain("https://api.cf.eu10-005.hana.ondemand.com");
  expect(rawTrace).toContain("https://api.cf.eu20-001.hana.ondemand.com");
  expect(rawTrace).toContain("https://api.cf.cn40.platform.sapcloud.cn");
  expect(rawTrace).not.toContain("secret");
});

test("Bare auth fallback uses the validated current API endpoint", async () => {
  const result = await runCli(
    ["info", "app-demo", "--read-only"],
    fakeEnv({ directAuthFail: true }),
  );
  expect(result.exitCode).toBe(0);
  const traces = await readFakeCfTraceEntries(home);
  expect(traces.some((entry) => entry.kind === "api" && entry.apiEndpoint === "https://api.cf.eu10-005.hana.ondemand.com")).toBe(true);
  expect(traces.some((entry) => entry.kind === "auth" && entry.hasUsername === true && entry.hasPassword === true)).toBe(true);
  expect(JSON.stringify(traces)).not.toContain("secret");
});

test("Malformed current endpoint is rejected before isolated auth", async () => {
  const result = await runCli(
    ["info", "app-demo", "--read-only"],
    fakeEnv({ apiEndpoint: "https://api.cf.eu10.hana.ondemand.com.attacker.example" }),
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("No current CF target found");
  const traces = await readFakeCfTraceEntries(home);
  expect(traces.some((entry) => entry.kind === "api" || entry.kind === "auth")).toBe(false);
});

test("Deprecated refresh flag is accepted but metadata cache uses refresh-metadata", async () => {
  const help = await runCli(["query", "--help"], fakeEnv());
  expect(help.stdout).toContain("deprecated compatibility flag");
  const first = await runCli(["query", SELECTOR, "SELECT * FROM MISSING_TABLES", "--refresh"], fakeEnv({ trace: true }));
  expect(first.exitCode).toBe(1);
  const second = await runCli(["query", SELECTOR, "SELECT * FROM MISSING_TABLES", "--refresh"], fakeEnv({ trace: true }));
  expect(second.exitCode).toBe(1);
  const traces = await readFakeTraceEntries(home);
  const metadataReads = traces.filter((entry) => entry.sql.includes("SYS.TABLES") && entry.sql.includes("SYS.VIEWS"));
  expect(metadataReads).toHaveLength(1);
});

test("User can save a compact query and inspect it by ref", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT * FROM ITEMS", "--save", "--cell-limit", "6"],
    fakeEnv(),
  );

  expect(result.exitCode).toBe(0);
  const lines = result.stdout.trimEnd().split(/\r?\n/);
  expect(lines[0]).toMatch(/^ref=q[0-9a-f]{8}$/);
  expect(lines[1]).toBe("ID,NAME");
  expect(lines[2]).toBe("1,sample");
  expect(result.stderr).not.toContain("saved result expires at");
  expect(result.stderr).toContain("compacted 2 cell(s)");

  const ref = lines[0]?.slice("ref=".length) ?? "";
  expect(result.stderr).toContain(
    `cf-hana result show ${ref} --row <r> --column <c>`,
  );
  expect(result.stderr).not.toContain("use --save to inspect");
  const cell = await runCli(
    ["result", "show", ref, "--row", "1", "--column", "NAME", "--length", "50"],
    fakeEnv(),
  );
  expect(cell.exitCode).toBe(0);
  expect(cell.stdout.trim()).toBe(
    "ROW,COLUMN,TYPE,ORIGINAL_LENGTH,OFFSET,VALUE\r\n1,NAME,text,10,0,sample-row",
  );

  const search = await runCli(["result", "search", ref, "SECOND"], fakeEnv());
  expect(search.exitCode).toBe(0);
  expect(search.stdout).toContain("2,NAME,0,,second-row");

  const missingColumn = await runCli(
    ["result", "show", ref, "--row", "1", "--path", "/items"],
    fakeEnv(),
  );
  expect(missingColumn.exitCode).toBe(1);
  expect(missingColumn.stderr).toContain("--path and --offset require --column");

  const list = await runCli(["result", "list"], fakeEnv());
  expect(list.exitCode).toBe(0);
  expect(list.stdout).toContain(ref);
});

test("User sees text LOB values as text and binary LOB values as hex", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT * FROM LOB_FIXTURE", "--save", "--cell-limit", "100"],
    fakeEnv(),
  );

  expect(result.exitCode).toBe(0);
  const lines = result.stdout.trimEnd().split(/\r?\n/);
  expect(lines[1]).toBe("LOG_CONTENT,CLOB_CONTENT,PAYLOAD");
  expect(lines[2]).toBe("Example log entry,Clob log entry,0x000102ff");

  const ref = lines[0]?.slice("ref=".length) ?? "";
  const show = await runCli(
    ["result", "show", ref, "--row", "1", "--column", "LOG_CONTENT", "--length", "100"],
    fakeEnv(),
  );
  expect(show.exitCode).toBe(0);
  expect(show.stdout.trim()).toBe(
    "ROW,COLUMN,TYPE,ORIGINAL_LENGTH,OFFSET,VALUE\r\n1,LOG_CONTENT,text,17,0,Example log entry",
  );

  const search = await runCli(["result", "search", ref, "Example"], fakeEnv());
  expect(search.exitCode).toBe(0);
  expect(search.stdout).toContain("1,LOG_CONTENT,0,,Example log entry");

  const textOutput = join(home, "log.txt");
  const textExport = await runCli(
    ["result", "export", ref, "--row", "1", "--column", "LOG_CONTENT", "--output", textOutput],
    fakeEnv(),
  );
  expect(textExport.exitCode).toBe(0);
  await expect(readFile(textOutput, "utf8")).resolves.toBe("Example log entry");

  const binaryOutput = join(home, "payload.bin");
  const binaryExport = await runCli(
    ["result", "export", ref, "--row", "1", "--column", "PAYLOAD", "--output", binaryOutput],
    fakeEnv(),
  );
  expect(binaryExport.exitCode).toBe(0);
  await expect(readFile(binaryOutput)).resolves.toEqual(Buffer.from([0, 1, 2, 255]));
});


test("User gets invalid table suggestions on stderr and cached metadata is reused", async () => {
  const sql = "SELECT\n\n *\n FROM\n\n MISSING_TABLES\n WHERE ID = ?";
  const first = await runCli(["query", SELECTOR, sql, "--param", "1"], fakeEnv({ trace: true }));
  expect(first.exitCode).toBe(1);
  expect(first.stdout).toBe("");
  expect(first.stderr).toContain("Did you mean:");
  expect(first.stderr).toContain("APP_SCHEMA.MISSING_TABLE_FIXED (TABLE)");

  const second = await runCli(["query", SELECTOR, sql, "--param", "1"], fakeEnv({ trace: true }));
  expect(second.exitCode).toBe(1);
  const traces = await readFakeTraceEntries(home);
  const metadataReads = traces.filter((entry) => entry.sql.includes("SYS.TABLES") && entry.sql.includes("SYS.VIEWS"));
  expect(metadataReads).toHaveLength(1);

  const refreshed = await runCli(["query", SELECTOR, sql, "--param", "1", "--refresh-metadata"], fakeEnv({ trace: true }));
  expect(refreshed.exitCode).toBe(1);
  const refreshedTraces = await readFakeTraceEntries(home);
  const refreshedMetadataReads = refreshedTraces.filter((entry) => entry.sql.includes("SYS.TABLES") && entry.sql.includes("SYS.VIEWS"));
  expect(refreshedMetadataReads).toHaveLength(2);

  await expect(readHistoryEntries(home)).rejects.toThrow();
});

test("User still gets suggestions after one transient metadata lookup failure", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT * FROM MISSING_TABLES"],
    fakeEnv({ trace: true, failCatalogOnce: true }),
  );
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("APP_SCHEMA.MISSING_TABLE_FIXED (TABLE)");
  const traces = await readFakeTraceEntries(home);
  const metadataReads = traces.filter((entry) => entry.sql.includes("SYS.TABLES") && entry.sql.includes("SYS.VIEWS"));
  expect(metadataReads).toHaveLength(2);
});

test("User gets invalid column suggestions for close typos", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT ISACTIVE FROM CORE_AUTH_SCOPE"],
    fakeEnv({ trace: true }),
  );
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Did you mean column:");
  expect(result.stderr).toContain("IS_ACTIVE");
  const traces = await readFakeTraceEntries(home);
  expect(traces.some((entry) => entry.sql.includes("SYS.TABLE_COLUMNS"))).toBe(true);
});

test("User gets actionable hints for LOB ORDER BY and GROUP BY errors", async () => {
  const ordered = await runCli(
    ["query", SELECTOR, "SELECT * FROM LOB_ORDER_ERROR ORDER BY LOG_CONTENT"],
    fakeEnv(),
  );
  expect(ordered.exitCode).toBe(1);
  expect(ordered.stderr).toContain("HANA cannot ORDER BY or GROUP BY");
  expect(ordered.stderr).toContain("TO_VARCHAR(<column>)");

  const grouped = await runCli(
    ["query", SELECTOR, "SELECT LOG_CONTENT FROM LOB_GROUP_ERROR GROUP BY LOG_CONTENT"],
    fakeEnv(),
  );
  expect(grouped.exitCode).toBe(1);
  expect(grouped.stderr).toContain("HANA cannot ORDER BY or GROUP BY");
  expect(grouped.stderr).toContain("TO_VARCHAR(<column>)");
});

test("User gets invalid table suggestions for quoted schema-qualified and DML statements", async () => {
  const quoted = await runCli(["query", SELECTOR, "SELECT * FROM \"APP_SCHEMA\".\"MISSING_TABLES\""], fakeEnv());
  expect(quoted.exitCode).toBe(1);
  expect(quoted.stdout).toBe("");
  expect(quoted.stderr).toContain("APP_SCHEMA.MISSING_TABLE_FIXED (TABLE)");

  const update = await runCli(["query", SELECTOR, "UPDATE APP_SCHEMA.MISSING_TABLES SET STATUS = ? WHERE ID = ?", "--param", "A", "--param", "1"], fakeEnv());
  expect(update.exitCode).toBe(1);
  expect(update.stdout).toBe("");
  expect(update.stderr).toContain("Did you mean:");
});

test("User can run a query and keep local SQL history", async () => {
  const result = await runCli(
    [
      "query",
      SELECTOR,
      "SELECT * FROM ORDERS WHERE STATUS = ?",
      "--param",
      "hidden-parameter-value",
    ],
    fakeEnv(),
  );
  expect(result.exitCode).toBe(0);

  const history = await readHistoryEntries(home);
  expect(history).toEqual([
    expect.objectContaining({
      selector: SELECTOR,
      appName: "app-demo",
      schema: "APP_SCHEMA",
      operation: "query",
      statement: "select",
      sql: "SELECT * FROM ORDERS WHERE STATUS = ?",
      paramCount: 1,
    }),
  ]);
  expect(JSON.stringify(history)).not.toContain("hidden-parameter-value");
});

test("User can back up rows before an UPDATE runs", async () => {
  const sql = "UPDATE ORDERS SET STATUS = ? WHERE ID = ?";
  const result = await runCli(
    ["query", SELECTOR, sql, "--param", "DONE", "--param", "7"],
    fakeEnv(),
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("(1 row(s) affected)");
  expect(result.stderr).toContain("backup saved to");

  await expect(readBackupFiles(home)).resolves.toEqual([
    {
      statement: `${sql}\n`,
      csv: BACKUP_CSV,
    },
  ]);
});

test("User can back up rows for a complex UPDATE before the write runs", async () => {
  const result = await runCli(
    [
      "query",
      SELECTOR,
      COMPLEX_UPDATE_SQL,
      "--param",
      "updated-note",
      "--param",
      "OPEN",
      "--param",
      "7",
      "--param",
      "READY",
      "--param",
      "PENDING",
    ],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("(1 row(s) affected)");
  expect(result.stderr).toContain("backup saved to");
  const trace = await readFakeTraceEntries(home);
  expect(trace).toEqual([
    { sql: COMPLEX_UPDATE_SELECT, paramCount: 3 },
    { sql: COMPLEX_UPDATE_SQL, paramCount: 5 },
  ]);
  expect(JSON.stringify(trace)).not.toContain("updated-note");
  await expect(readBackupFiles(home)).resolves.toEqual([
    { statement: `${COMPLEX_UPDATE_SQL.slice(0, -1)}\n`, csv: BACKUP_CSV },
  ]);
});

test("User can back up rows for a complex DELETE before the write runs", async () => {
  const result = await runCli(
    [
      "query",
      SELECTOR,
      COMPLEX_DELETE_SQL,
      "--param",
      "OPEN",
      "--param",
      "STANDARD",
    ],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("(1 row(s) affected)");
  expect(result.stderr).toContain("backup saved to");
  expect(await readFakeTraceEntries(home)).toEqual([
    { sql: COMPLEX_DELETE_SELECT, paramCount: 2 },
    { sql: COMPLEX_DELETE_SQL, paramCount: 2 },
  ]);
  await expect(readBackupFiles(home)).resolves.toEqual([
    { statement: `${COMPLEX_DELETE_SQL.slice(0, -1)}\n`, csv: BACKUP_CSV },
  ]);
});

test("User can back up all rows before an explicitly allowed unscoped UPDATE", async () => {
  const sql = "UPDATE ORDERS SET STATUS = ?";
  const result = await runCli(
    [
      "query",
      SELECTOR,
      sql,
      "--param",
      "ARCHIVED",
      "--allow-destructive",
    ],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("(1 row(s) affected)");
  expect(result.stderr).toContain("backup saved to");
  expect(await readFakeTraceEntries(home)).toEqual([
    { sql: "SELECT * FROM ORDERS", paramCount: 0 },
    { sql, paramCount: 1 },
  ]);
  await expect(readBackupFiles(home)).resolves.toEqual([
    { statement: `${sql}\n`, csv: BACKUP_CSV },
  ]);
});

test("User cannot run an unscoped DELETE before explicit approval", async () => {
  const result = await runCli(
    ["query", SELECTOR, "DELETE FROM ORDERS"],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("destructive statement blocked");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});

test("User can back up all rows before an explicitly allowed unscoped DELETE", async () => {
  const sql = "DELETE FROM ORDERS";
  const result = await runCli(
    ["query", SELECTOR, sql, "--allow-destructive"],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("(1 row(s) affected)");
  expect(result.stderr).toContain("backup saved to");
  expect(await readFakeTraceEntries(home)).toEqual([
    { sql: "SELECT * FROM ORDERS", paramCount: 0 },
    { sql, paramCount: 0 },
  ]);
  await expect(readBackupFiles(home)).resolves.toEqual([
    { statement: `${sql}\n`, csv: BACKUP_CSV },
  ]);
});

test("User cannot run an UPDATE when the backup SELECT fails", async () => {
  const sql = "UPDATE ORDERS SET STATUS = ? WHERE ID = ?";
  const result = await runCli(
    ["query", SELECTOR, sql, "--param", "DONE", "--param", "7"],
    fakeEnv({ trace: true, failStatement: "select" }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("fake driver forced SELECT failure");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([
    { sql: "SELECT * FROM ORDERS WHERE ID = ?", paramCount: 1 },
  ]);
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});

test("User keeps the backup when the UPDATE itself fails", async () => {
  const sql = "UPDATE ORDERS SET STATUS = ? WHERE ID = ?";
  const result = await runCli(
    ["query", SELECTOR, sql, "--param", "DONE", "--param", "7"],
    fakeEnv({ trace: true, failStatement: "dml" }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("fake driver forced DML failure");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([
    { sql: "SELECT * FROM ORDERS WHERE ID = ?", paramCount: 1 },
    { sql, paramCount: 2 },
  ]);
  await expect(readBackupFiles(home)).resolves.toEqual([
    { statement: `${sql}\n`, csv: BACKUP_CSV },
  ]);
});

test("User cannot run an UPDATE when the local backup cannot be written", async () => {
  const sapDir = join(home, ".saptools");
  await mkdir(sapDir, { recursive: true });
  await writeFile(join(sapDir, "cf-hana"), "blocked", "utf8");
  const sql = "UPDATE ORDERS SET STATUS = ? WHERE ID = ?";
  const result = await runCli(
    ["query", SELECTOR, sql, "--param", "DONE", "--param", "7"],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).not.toContain("backup saved to");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([
    { sql: "SELECT * FROM ORDERS WHERE ID = ?", paramCount: 1 },
  ]);
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});

test("User cannot run a scoped UPDATE in read-only mode", async () => {
  const result = await runCli(
    [
      "query",
      SELECTOR,
      "UPDATE ORDERS SET STATUS = ? WHERE ID = ?",
      "--param",
      "DONE",
      "--param",
      "7",
      "--read-only",
    ],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("read-only mode blocks DML");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});

test("User cannot run an UPDATE with a parameter-count mismatch", async () => {
  const result = await runCli(
    [
      "query",
      SELECTOR,
      "UPDATE ORDERS SET STATUS = ? WHERE ID = ?",
      "--param",
      "DONE",
    ],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("expects 2 bound parameter");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});

test("User cannot run an UPDATE with an empty WHERE clause", async () => {
  const result = await runCli(
    ["query", SELECTOR, "UPDATE ORDERS SET STATUS = ? WHERE", "--param", "DONE"],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("non-empty WHERE clause");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});

test("User cannot run unsupported DELETE syntax", async () => {
  const result = await runCli(
    ["query", SELECTOR, "DELETE ORDERS WHERE ID = ?", "--param", "7"],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("DELETE FROM");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});

test("User can see a clear failure for the removed backup opt-out", async () => {
  const result = await runCli(
    [
      "query",
      SELECTOR,
      "UPDATE ORDERS SET STATUS = ? WHERE ID = ?",
      "--param",
      "DONE",
      "--param",
      "7",
      "--no-backup",
    ],
    fakeEnv(),
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("unknown option '--no-backup'");
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});

test("User can ping the database", async () => {
  const result = await runCli(["ping", SELECTOR], fakeEnv());
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("OK");
});

test("User can see a clear failure for an uncached app", async () => {
  const result = await runCli(["info", "definitely-missing-app"], fakeEnv());
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("cf-hana");
});

test("User can see a clear failure for a non-integer limit", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT 1 FROM DUMMY", "--limit", "10abc"],
    fakeEnv(),
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Expected an integer");
});

test("User can see a clear failure for a non-positive timeout", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT 1 FROM DUMMY", "--timeout", "0"],
    fakeEnv(),
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("positive integer");
});

test("User can see a clear failure for an oversized cell limit", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT 1 FROM DUMMY", "--cell-limit", "10001"],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("--cell-limit must be at most 10000");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
});

test("User cannot save a write statement as a result ref", async () => {
  const result = await runCli(
    ["query", SELECTOR, "UPDATE ORDERS SET STATUS = ? WHERE ID = ?", "--param", "DONE", "--save"],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("--save is only available");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});
