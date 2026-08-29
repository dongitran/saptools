import { describe, expect, it } from "vitest";

import { formatCsv, formatJson, formatJsonCompact, formatResult, formatTable } from "../../src/format.js";

const rows = [
  { NAME: "POST", COUNT: 178 },
  { NAME: "HEAD", COUNT: 176 },
];

describe("formatTable", () => {
  it("renders an aligned header, separator, and rows", () => {
    const text = formatTable(rows);
    const lines = text.split("\n");
    expect(lines[0]).toBe("NAME | COUNT");
    expect(lines[1]).toMatch(/^-+-\+-+$/);
    expect(lines[2]).toBe("POST | 178  "); // COUNT column width is 5 (from the "COUNT" header), so "178" pads to 5
  });

  it("renders a placeholder for zero rows", () => {
    expect(formatTable([])).toBe("(no rows)");
  });

  it("collects the union of columns across heterogeneous rows", () => {
    const text = formatTable([{ A: 1 }, { B: 2 }]);
    expect(text.split("\n")[0]).toBe("A | B");
  });
});

describe("formatJson", () => {
  it("round-trips rows losslessly", () => {
    expect(JSON.parse(formatJson(rows))).toEqual(rows);
  });
});

describe("formatJsonCompact", () => {
  it("emits a bare array for a single-column result", () => {
    expect(JSON.parse(formatJsonCompact([{ NAME: "POST" }, { NAME: "HEAD" }]))).toEqual(["POST", "HEAD"]);
  });

  it("uses the preferred column when multiple columns exist", () => {
    expect(JSON.parse(formatJsonCompact(rows, "NAME"))).toEqual(["POST", "HEAD"]);
  });

  it("falls back to full JSON when multi-column and no preferred column is given", () => {
    expect(JSON.parse(formatJsonCompact(rows))).toEqual(rows);
  });
});

describe("formatCsv", () => {
  it("renders RFC 4180 CSV with a header row", () => {
    expect(formatCsv(rows)).toBe("NAME,COUNT\r\nPOST,178\r\nHEAD,176");
  });

  it("quotes and escapes a cell containing a comma or quote", () => {
    expect(formatCsv([{ A: 'a,"b"' }])).toBe('A\r\n"a,""b"""');
  });
});

describe("formatResult", () => {
  it("dispatches to the right formatter for each format", () => {
    expect(formatResult(rows, "table")).toBe(formatTable(rows));
    expect(formatResult(rows, "json")).toBe(formatJson(rows));
    expect(formatResult(rows, "csv")).toBe(formatCsv(rows));
    expect(formatResult(rows, "json-compact")).toBe(formatJsonCompact(rows, undefined));
  });
});
