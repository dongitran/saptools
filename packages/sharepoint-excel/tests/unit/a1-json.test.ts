import { describe, expect, it } from "vitest";

import { columnNameToNumber, parseA1Cell, parseA1Range } from "../../src/workbook/a1.js";
import { parseCellValue, parseHeaders, parseWorkbookRows } from "../../src/workbook/json.js";

describe("A1 parsing", () => {
  it("converts column names to numbers", () => {
    expect(columnNameToNumber("A")).toBe(1);
    expect(columnNameToNumber("Z")).toBe(26);
    expect(columnNameToNumber("AA")).toBe(27);
  });

  it("parses cells and ordered ranges", () => {
    expect(parseA1Cell("b12")).toEqual({ row: 12, column: 2 });
    expect(parseA1Range("D4")).toEqual({
      start: { row: 4, column: 4 },
      end: { row: 4, column: 4 },
    });
    expect(parseA1Range("C3:A1")).toEqual({
      start: { row: 1, column: 1 },
      end: { row: 3, column: 3 },
    });
  });

  it("rejects invalid references", () => {
    expect(() => parseA1Cell("1A")).toThrow(/Invalid A1/);
    expect(() => parseA1Range("A1:B2:C3")).toThrow(/Invalid A1 range/);
    expect(() => columnNameToNumber("A1")).toThrow(/Invalid column/);
  });
});

describe("CLI JSON parsers", () => {
  it("parses comma-separated headers", () => {
    expect(parseHeaders(" Name, Amount ,, Status ")).toEqual(["Name", "Amount", "Status"]);
  });

  it("parses scalar cell values with string fallback", () => {
    expect(parseCellValue("42")).toBe(42);
    expect(parseCellValue("true")).toBe(true);
    expect(parseCellValue("plain text")).toBe("plain text");
  });

  it("normalises row JSON into a list of workbook input rows", () => {
    expect(parseWorkbookRows('{"Name":"A","Amount":1}')).toEqual([{ Name: "A", Amount: 1 }]);
    expect(parseWorkbookRows('["A",1,true]')).toEqual([["A", 1, true]]);
    expect(parseWorkbookRows('[{"Name":"A"},{"Name":"B"}]')).toEqual([{ Name: "A" }, { Name: "B" }]);
  });

  it("rejects nested unsupported values", () => {
    expect(() => parseWorkbookRows('{"Name":{"nested":true}}')).toThrow(/Rows JSON/);
    expect(parseWorkbookRows(undefined)).toEqual([]);
    expect(parseCellValue("")).toBe("");
  });
});
