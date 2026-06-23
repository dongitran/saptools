import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendSqlHistory,
  cfHanaHistoryDirectory,
  sqlHistoryFilePath,
} from "../../src/history.js";
import type { SqlHistoryEntryInput } from "../../src/history.js";

let rootDir: string;

function fixedNow(): Date {
  return new Date(2026, 5, 23, 12, 0, 0);
}

function sampleEntry(overrides: Partial<SqlHistoryEntryInput> = {}): SqlHistoryEntryInput {
  return {
    version: "0.1.3",
    operation: "query",
    selector: "eu10/example-org/space-demo/app-demo",
    appName: "app-demo",
    schema: "APP_SCHEMA",
    role: "runtime",
    statement: "select",
    sql: "SELECT * FROM ORDERS WHERE ID = ?",
    paramCount: 1,
    rowCount: 1,
    truncated: false,
    elapsedMs: 12,
    ...overrides,
  };
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "cf-hana-history-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("SQL history", () => {
  it("builds the dated history path under the cf-hana histories folder", () => {
    const saptoolsRoot = join(rootDir, ".saptools");

    expect(cfHanaHistoryDirectory(saptoolsRoot)).toBe(
      join(saptoolsRoot, "cf-hana", "histories"),
    );
    expect(sqlHistoryFilePath(fixedNow(), saptoolsRoot)).toBe(
      join(saptoolsRoot, "cf-hana", "histories", "2026-06-23.jsonl"),
    );
  });

  it("appends JSONL entries without parameter values or result rows", async () => {
    const saptoolsRoot = join(rootDir, ".saptools");
    const entry = await appendSqlHistory(sampleEntry(), {
      now: fixedNow(),
      saptoolsRoot,
    });

    const raw = await readFile(sqlHistoryFilePath(fixedNow(), saptoolsRoot), "utf8");
    const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;

    expect(entry.at).toBe(fixedNow().toISOString());
    expect(parsed).toMatchObject({
      selector: "eu10/example-org/space-demo/app-demo",
      appName: "app-demo",
      schema: "APP_SCHEMA",
      operation: "query",
      statement: "select",
      sql: "SELECT * FROM ORDERS WHERE ID = ?",
      paramCount: 1,
      rowCount: 1,
    });
    expect(parsed["params"]).toBeUndefined();
    expect(parsed["rows"]).toBeUndefined();
    expect(raw).not.toContain("hidden-parameter-value");
  });

  it("deletes dated history files older than five days and keeps unrelated files", async () => {
    const saptoolsRoot = join(rootDir, ".saptools");
    const historyDir = cfHanaHistoryDirectory(saptoolsRoot);

    await mkdir(historyDir, { recursive: true });
    await writeFile(join(historyDir, "2026-06-17.jsonl"), "{}\n", "utf8");
    await writeFile(join(historyDir, "2026-06-18.jsonl"), "{}\n", "utf8");
    await writeFile(join(historyDir, "notes.txt"), "keep\n", "utf8");

    await appendSqlHistory(sampleEntry(), {
      now: fixedNow(),
      saptoolsRoot,
    });

    await expect(readdir(historyDir)).resolves.toEqual(
      expect.arrayContaining(["2026-06-18.jsonl", "2026-06-23.jsonl", "notes.txt"]),
    );
    await expect(readdir(historyDir)).resolves.not.toContain("2026-06-17.jsonl");
  });
});
