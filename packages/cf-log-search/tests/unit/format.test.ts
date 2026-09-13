import { describe, expect, it } from "vitest";

import { formatCsv, formatJson, formatJsonCompact, formatResult, formatTable } from "../../src/format.js";

describe("formatTable", () => {
  it("renders (no rows) for an empty array", () => {
    expect(formatTable([])).toBe("(no rows)");
  });

  it("renders an aligned table with a header and separator row", () => {
    // Column widths are 2/2 (from "yy"/"22"), so a shorter cell in a row —
    // "B", "1" — pads with a trailing space to fill its column; verified
    // against cf-metrics's own real formatTable test, which documents the
    // identical padding behavior for its "COUNT"/"178" case.
    const output = formatTable([{ A: "x", B: 1 }, { A: "yy", B: 22 }]);
    expect(output).toBe("A  | B \n---+---\nx  | 1 \nyy | 22");
  });
});

describe("formatJson", () => {
  it("renders pretty-printed JSON", () => {
    expect(formatJson([{ A: 1 }])).toBe(JSON.stringify([{ A: 1 }], null, 2));
  });
});

describe("formatJsonCompact", () => {
  it("renders a bare array of one column's values when only one column exists", () => {
    expect(formatJsonCompact([{ A: 1 }, { A: 2 }])).toBe(JSON.stringify([1, 2], null, 2));
  });

  it("falls back to full JSON when more than one column exists and none is preferred", () => {
    expect(formatJsonCompact([{ A: 1, B: 2 }])).toBe(formatJson([{ A: 1, B: 2 }]));
  });
});

describe("formatCsv", () => {
  it("quotes a value containing a comma", () => {
    expect(formatCsv([{ A: "x,y" }])).toBe('A\r\n"x,y"');
  });
});

describe("formatResult", () => {
  it("dispatches to the format named by the OutputFormat value", () => {
    expect(formatResult([{ A: 1 }], "json")).toBe(formatJson([{ A: 1 }]));
    expect(formatResult([], "table")).toBe("(no rows)");
  });
});
