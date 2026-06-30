import { describe, expect, it } from "vitest";

import {
  inspectJsonCell,
  readCellWindow,
  searchResultSession,
  selectResultCell,
  selectResultRow,
} from "../../src/result-inspect.js";
import type { ResultSession } from "../../src/result-store.js";

function session(): ResultSession {
  return {
    ref: "qabc12345",
    createdAt: "2026-06-25T00:00:00.000Z",
    expiresAt: "2026-06-25T01:00:00.000Z",
    ttlMinutes: 60,
    directory: "/tmp/qabc12345",
    path: "/tmp/qabc12345/manifest.json",
    info: {
      selector: "eu10/neutral-org/dev/neutral-app",
      appName: "neutral-app",
      host: "hana.example.internal",
      schema: "APP_SCHEMA",
      role: "runtime",
      driver: "fake",
      credentialSource: "live",
    },
    result: {
      rows: [
        {
          ID: 1,
          CONTENT: "Alpha ready and alpha complete",
          PAYLOAD:
            '{"records":[{"details":{"name":"Alpha Item","tags":["one","two"]}}]}',
        },
        { ID: 2, CONTENT: "No match", PAYLOAD: '{"state":"closed"}' },
      ],
      columns: [
        { name: "ID", typeName: "INTEGER" },
        { name: "CONTENT", typeName: "NCLOB" },
        { name: "PAYLOAD", typeName: "NCLOB" },
      ],
      rowCount: 2,
      statement: "select",
      truncated: false,
      elapsedMs: 4,
    },
  };
}

describe("saved result inspection", () => {
  it("selects one-based rows and exact column names", () => {
    expect(selectResultRow(session(), 1)).toMatchObject({ ID: 1 });
    expect(selectResultCell(session(), 1, "CONTENT")).toMatchObject({
      column: "CONTENT",
      typeName: "NCLOB",
      value: "Alpha ready and alpha complete",
    });
    expect(() => selectResultRow(session(), 0)).toThrow(/row 0/i);
    expect(() => selectResultCell(session(), 1, "content")).toThrow(/column/);
  });

  it("reads text ranges using Unicode code-point offsets", () => {
    const window = readCellWindow("A😀BCDEF", 2, 3);

    expect(window).toEqual({
      type: "text",
      originalLength: 7,
      offset: 2,
      value: "BCD",
    });
  });

  it("reads Buffer ranges using byte offsets", () => {
    const window = readCellWindow(Buffer.from([0, 1, 2, 3]), 1, 2);

    expect(window).toEqual({
      type: "binary",
      originalLength: 4,
      offset: 1,
      value: "0x0102",
    });
  });

  it("reads text LOB buffers using text ranges", () => {
    const window = readCellWindow(Buffer.from("Example log entry", "utf8"), 8, 3, "NCLOB");

    expect(window).toEqual({
      type: "text",
      originalLength: 17,
      offset: 8,
      value: "log",
    });
  });

  it("searches decoded text LOB buffers", () => {
    const lobSession: ResultSession = {
      ...session(),
      result: {
        ...session().result,
        rows: [{ ID: 1, CONTENT: Buffer.from("Example log entry", "utf8") }],
        columns: [
          { name: "ID", typeName: "INTEGER" },
          { name: "CONTENT", typeName: "NCLOB" },
        ],
        rowCount: 1,
      },
    };

    expect(searchResultSession(lobSession, "log", { limit: 10 })).toEqual([
      expect.objectContaining({
        row: 1,
        column: "CONTENT",
        offset: 8,
        preview: "Example log entry",
      }),
    ]);
  });

  it("resolves an RFC 6901 JSON Pointer", () => {
    const rows = inspectJsonCell(
      selectResultCell(session(), 1, "PAYLOAD").value,
      "/records/0/details",
      128,
    );

    expect(rows).toEqual([
      { path: "/records/0/details/name", type: "string", value: "Alpha Item" },
      { path: "/records/0/details/tags", type: "array", value: "items=2" },
    ]);
  });

  it("supports escaped JSON Pointer tokens", () => {
    const rows = inspectJsonCell('{"a/b":{"m~n":"value"}}', "/a~1b/m~0n", 128);

    expect(rows).toEqual([{ path: "/a~1b/m~0n", type: "string", value: "value" }]);
  });

  it("searches text and JSON keys or values case-insensitively", () => {
    const matches = searchResultSession(session(), "ALPHA", { limit: 10 });

    expect(matches).toEqual([
      expect.objectContaining({ row: 1, column: "CONTENT", offset: 0, path: "" }),
      expect.objectContaining({ row: 1, column: "CONTENT", offset: 16, path: "" }),
      expect.objectContaining({
        row: 1,
        column: "PAYLOAD",
        path: "/records/0/details/name",
      }),
    ]);
  });

  it("narrows searches and enforces the match limit", () => {
    const matches = searchResultSession(session(), "alpha", {
      row: 1,
      column: "CONTENT",
      limit: 1,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.column).toBe("CONTENT");
  });

  it("bounds search previews with the requested length", () => {
    const matches = searchResultSession(session(), "ready", {
      limit: 1,
      previewLength: 5,
    });

    expect(matches[0]?.preview).toBe("Alpha");
  });
});
