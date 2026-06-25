import { describe, expect, it } from "vitest";

import {
  formatCompactCsv,
  formatCsv,
  formatJson,
  formatResult,
  formatTable,
} from "../../src/format.js";
import type { QueryResult } from "../../src/types.js";

function selectResult(): QueryResult {
  return {
    rows: [
      { ID: 1, NAME: "Alice" },
      { ID: 2, NAME: "Bob" },
    ],
    columns: [
      { name: "ID", typeName: "INTEGER" },
      { name: "NAME", typeName: "NVARCHAR" },
    ],
    rowCount: 2,
    statement: "select",
    truncated: false,
    elapsedMs: 4,
  };
}

function dmlResult(): QueryResult {
  return {
    rows: [],
    columns: [],
    rowCount: 3,
    statement: "dml",
    truncated: false,
    elapsedMs: 1,
  };
}

describe("formatTable", () => {
  it("renders headers, a separator and aligned rows", () => {
    const text = formatTable(selectResult());
    const lines = text.split("\n");
    expect(lines[0]).toContain("ID");
    expect(lines[0]).toContain("NAME");
    expect(lines[1]).toMatch(/^-+\+-+$/);
    expect(text).toContain("Alice");
    expect(text).toContain("Bob");
  });

  it("reports affected rows when there are no columns", () => {
    expect(formatTable(dmlResult())).toBe("(3 row(s) affected)");
  });

  it("renders dates, buffers, booleans and nulls", () => {
    const result: QueryResult = {
      rows: [
        {
          WHEN: new Date("2026-05-22T00:00:00.000Z"),
          BLOB: Buffer.from([1]),
          FLAG: true,
          GAP: null,
        },
      ],
      columns: [
        { name: "WHEN", typeName: "TIMESTAMP" },
        { name: "BLOB", typeName: "BLOB" },
        { name: "FLAG", typeName: "BOOLEAN" },
        { name: "GAP", typeName: "NVARCHAR" },
      ],
      rowCount: 1,
      statement: "select",
      truncated: false,
      elapsedMs: 0,
    };
    const text = formatTable(result);
    expect(text).toContain("2026-05-22T00:00:00.000Z");
    expect(text).toContain("0x01");
    expect(text).toContain("true");
    expect(text).toContain("NULL");
  });
});

describe("formatJson", () => {
  it("serializes rows as JSON", () => {
    const parsed: unknown = JSON.parse(formatJson(selectResult()));
    expect(parsed).toEqual([
      { ID: 1, NAME: "Alice" },
      { ID: 2, NAME: "Bob" },
    ]);
  });

  it("serializes dates, buffers and null cells", () => {
    const result: QueryResult = {
      rows: [{ WHEN: new Date("2026-05-22T00:00:00.000Z"), BLOB: Buffer.from([1, 255]), GAP: null }],
      columns: [
        { name: "WHEN", typeName: "TIMESTAMP" },
        { name: "BLOB", typeName: "BLOB" },
        { name: "GAP", typeName: "NVARCHAR" },
      ],
      rowCount: 1,
      statement: "select",
      truncated: false,
      elapsedMs: 0,
    };
    expect(JSON.parse(formatJson(result))).toEqual([
      { WHEN: "2026-05-22T00:00:00.000Z", BLOB: "0x01ff", GAP: null },
    ]);
  });
});

describe("formatCsv", () => {
  it("renders RFC 4180 rows", () => {
    expect(formatCsv(selectResult())).toBe("ID,NAME\r\n1,Alice\r\n2,Bob");
  });

  it("quotes values containing commas, quotes or newlines", () => {
    const result: QueryResult = {
      rows: [{ TEXT: 'a,"b"' }],
      columns: [{ name: "TEXT", typeName: "NVARCHAR" }],
      rowCount: 1,
      statement: "select",
      truncated: false,
      elapsedMs: 0,
    };
    expect(formatCsv(result)).toBe('TEXT\r\n"a,""b"""');
  });
});

describe("formatCompactCsv", () => {
  it("bounds every data cell and reports the truncated-cell count", () => {
    const result: QueryResult = {
      rows: [{ ID: 1, CONTENT: "x".repeat(200) }],
      columns: [
        { name: "ID", typeName: "INTEGER" },
        { name: "CONTENT", typeName: "NCLOB" },
      ],
      rowCount: 1,
      statement: "select",
      truncated: false,
      elapsedMs: 0,
    };

    const compact = formatCompactCsv(result, 128);

    expect(compact.text).toBe(`ID,CONTENT\r\n1,${"x".repeat(128)}`);
    expect(compact.truncatedCells).toBe(1);
  });

  it("keeps CSV escaping after previewing a value", () => {
    const result: QueryResult = {
      rows: [{ CONTENT: 'a,"b"' }],
      columns: [{ name: "CONTENT", typeName: "NVARCHAR" }],
      rowCount: 1,
      statement: "select",
      truncated: false,
      elapsedMs: 0,
    };

    expect(formatCompactCsv(result, 128).text).toBe('CONTENT\r\n"a,""b"""');
  });
});

describe("formatResult", () => {
  it("dispatches on the requested format", () => {
    const result = selectResult();
    expect(formatResult(result, "table")).toBe(formatTable(result));
    expect(formatResult(result, "json")).toBe(formatJson(result));
    expect(formatResult(result, "csv")).toBe(formatCsv(result));
  });
});
