import { describe, expect, it } from "vitest";

import {
  addWorkbookSheet,
  appendWorkbookRows,
  createWorkbookBytes,
  readWorkbookBytes,
  updateWorkbookCell,
} from "../../src/workbook/excel.js";

describe("workbook operations", () => {
  it("creates and reads a workbook with headers and object rows", async () => {
    const bytes = await createWorkbookBytes({
      sheetName: "Orders",
      headers: ["Name", "Amount"],
      rows: [{ Name: "Coffee", Amount: 3 }],
    });

    const read = await readWorkbookBytes(bytes, { sheetName: "Orders" });

    expect(read.sheets[0]?.rows).toEqual([
      ["Name", "Amount"],
      ["Coffee", 3],
    ]);
  });

  it("derives headers from object rows when none are provided", async () => {
    const bytes = await createWorkbookBytes({
      sheetName: "Data",
      headers: [],
      rows: [{ Name: "A", Active: true }],
    });

    const read = await readWorkbookBytes(bytes, { sheetName: "Data" });

    expect(read.sheets[0]?.rows).toEqual([
      ["Name", "Active"],
      ["A", true],
    ]);
  });

  it("appends objects by matching the header row", async () => {
    const initial = await createWorkbookBytes({
      sheetName: "Orders",
      headers: ["Name", "Amount"],
      rows: [{ Name: "Coffee", Amount: 3 }],
    });

    const updated = await appendWorkbookRows(
      initial,
      "Orders",
      [{ Amount: 8, Name: "Tea" }],
      true,
    );
    const read = await readWorkbookBytes(updated.bytes, { sheetName: "Orders" });

    expect(read.sheets[0]?.rows).toEqual([
      ["Name", "Amount"],
      ["Coffee", 3],
      ["Tea", 8],
    ]);
  });

  it("updates a single cell", async () => {
    const initial = await createWorkbookBytes({
      sheetName: "Orders",
      headers: ["Name", "Amount"],
      rows: [{ Name: "Coffee", Amount: 3 }],
    });

    const updated = await updateWorkbookCell(initial, "Orders", "B2", 4);
    const read = await readWorkbookBytes(updated.bytes, { sheetName: "Orders", range: "A1:B2" });

    expect(read.sheets[0]?.rows[1]).toEqual(["Coffee", 4]);
  });

  it("creates an Excel table when a table name is provided", async () => {
    const bytes = await createWorkbookBytes({
      sheetName: "Orders",
      headers: ["Name", "Amount"],
      rows: [{ Name: "Coffee", Amount: 3 }],
      tableName: "OrdersTable",
    });
    const read = await readWorkbookBytes(bytes, { sheetName: "Orders" });

    expect(read.sheets[0]?.rows[0]).toEqual(["Name", "Amount"]);
  });

  it("adds a new sheet with headers and rejects duplicates", async () => {
    const initial = await createWorkbookBytes({
      sheetName: "Orders",
      headers: ["Name"],
      rows: [],
    });

    const updated = await addWorkbookSheet(initial, "Audit", ["At", "Action"]);
    const read = await readWorkbookBytes(updated.bytes);

    expect(read.sheets.map((sheet) => sheet.name)).toEqual(["Orders", "Audit"]);
    expect(read.sheets[1]?.rows).toEqual([["At", "Action"]]);
    await expect(addWorkbookSheet(updated.bytes, "Audit", [])).rejects.toThrow(/already exists/);
  });

  it("rejects invalid sheet names", async () => {
    await expect(
      createWorkbookBytes({ sheetName: "Bad/Name", headers: [], rows: [] }),
    ).rejects.toThrow(/Invalid Excel sheet/);
    const bytes = await createWorkbookBytes({ sheetName: "Good", headers: [], rows: [] });
    await expect(readWorkbookBytes(bytes, { sheetName: "Missing" })).rejects.toThrow(/not found/);
  });
});
