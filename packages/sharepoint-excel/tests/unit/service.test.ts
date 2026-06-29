import { describe, expect, it } from "vitest";

import { GraphHttpError } from "../../src/graph/client.js";
import type { GraphClient, GraphRequestOptions } from "../../src/graph/client.js";
import type { SharePointExcelSession } from "../../src/session.js";
import { createWorkbookBytes, readWorkbookBytes } from "../../src/workbook/excel.js";
import {
  addRemoteWorkbookSheet,
  appendRemoteWorkbookRows,
  createRemoteWorkbook,
  readRemoteWorkbook,
  updateRemoteWorkbookCell,
} from "../../src/workbook/service.js";

class WorkbookClient implements GraphClient {
  public readonly baseUrl = "http://fake";
  private bytes: Uint8Array;
  private eTag = '"etag-1"';
  private exists: boolean;

  public constructor(initialBytes?: Uint8Array) {
    this.bytes = initialBytes ?? new Uint8Array();
    this.exists = initialBytes !== undefined;
  }

  public async requestJson<T>(path: string, options?: GraphRequestOptions): Promise<T> {
    if (path.includes("createUploadSession")) {
      return { uploadUrl: "http://upload/session" } as T;
    }
    if (path === "http://upload/session") {
      this.bytes = this.rawBytes(options);
      this.exists = true;
      return this.item("created") as T;
    }
    if (path.endsWith(":/content") && options?.method === "PUT") {
      if (options.headers?.["If-Match"] !== this.eTag) {
        throw new GraphHttpError(412, "preconditionFailed", "etag mismatch");
      }
      this.bytes = this.rawBytes(options);
      this.eTag = '"etag-2"';
      return this.item("updated") as T;
    }
    if (!this.exists) {
      throw new GraphHttpError(404, "itemNotFound", "missing");
    }
    return this.item("book") as T;
  }

  public async requestBytes(): Promise<Uint8Array> {
    return this.bytes;
  }

  public async requestNoContent(): Promise<void> {
    return undefined;
  }

  public currentBytes(): Uint8Array {
    return this.bytes;
  }

  private rawBytes(options: GraphRequestOptions | undefined): Uint8Array {
    if (options?.rawBody instanceof Uint8Array) {
      return options.rawBody;
    }
    throw new Error("Expected raw workbook bytes");
  }

  private item(id: string): Record<string, unknown> {
    return { id, name: "book.xlsx", size: this.bytes.byteLength, eTag: this.eTag, file: {} };
  }
}

function session(client: GraphClient): SharePointExcelSession {
  return {
    token: { accessToken: "token", tokenType: "Bearer", expiresOn: 1 },
    client,
    site: { id: "site", name: "demo", displayName: "Demo", webUrl: "" },
    drives: [{ id: "drive", name: "Documents", driveType: "documentLibrary", webUrl: "" }],
  };
}

describe("remote workbook service", () => {
  it("creates a workbook through Graph file helpers", async () => {
    const client = new WorkbookClient();
    const result = await createRemoteWorkbook(
      { session: session(client), driveHint: "Documents" },
      "Reports/book.xlsx",
      { sheetName: "Orders", headers: ["Name"], rows: [{ Name: "Coffee" }] },
    );
    const read = await readWorkbookBytes(client.currentBytes(), { sheetName: "Orders" });

    expect(result.item.id).toBe("created");
    expect(read.sheets[0]?.rows).toEqual([["Name"], ["Coffee"]]);
  });

  it("reads and mutates an existing workbook with ETag protection", async () => {
    const initial = await createWorkbookBytes({
      sheetName: "Orders",
      headers: ["Name", "Amount"],
      rows: [{ Name: "Coffee", Amount: 3 }],
    });
    const client = new WorkbookClient(initial);

    const read = await readRemoteWorkbook(
      { session: session(client), driveHint: "Documents" },
      "Reports/book.xlsx",
      { sheetName: "Orders" },
    );
    expect(read.workbook.sheets[0]?.rows[1]).toEqual(["Coffee", 3]);

    await appendRemoteWorkbookRows(
      { session: session(client), driveHint: "Documents" },
      "Reports/book.xlsx",
      "Orders",
      [{ Name: "Tea", Amount: 8 }],
      true,
    );
    await updateRemoteWorkbookCell(
      { session: session(client), driveHint: "Documents" },
      "Reports/book.xlsx",
      "Orders",
      "B2",
      4,
    );
    const updated = await readWorkbookBytes(client.currentBytes(), { sheetName: "Orders" });

    expect(updated.sheets[0]?.rows).toEqual([
      ["Name", "Amount"],
      ["Coffee", 4],
      ["Tea", 8],
    ]);
  });

  it("adds sheets and reports missing workbooks", async () => {
    const initial = await createWorkbookBytes({
      sheetName: "Orders",
      headers: ["Name"],
      rows: [],
    });
    const client = new WorkbookClient(initial);
    await addRemoteWorkbookSheet(
      { session: session(client), driveHint: "Documents" },
      "Reports/book.xlsx",
      "Audit",
      ["At", "Action"],
    );
    const updated = await readWorkbookBytes(client.currentBytes());

    expect(updated.sheets.map((sheet) => sheet.name)).toEqual(["Orders", "Audit"]);
    await expect(
      readRemoteWorkbook({ session: session(new WorkbookClient()) }, "Reports/missing.xlsx"),
    ).rejects.toThrow(/Workbook not found/);
  });

  it("rejects non-xlsx paths", async () => {
    const client = new WorkbookClient();
    await expect(
      createRemoteWorkbook(
        { session: session(client) },
        "Reports/book.csv",
        { sheetName: "Orders", headers: [], rows: [] },
      ),
    ).rejects.toThrow(/must end with .xlsx/);
  });
});
