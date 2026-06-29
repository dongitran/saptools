import { describe, expect, it } from "vitest";

import { createGraphClient, GraphHttpError } from "../../src/graph/client.js";
import type { FetchLike } from "../../src/graph/client.js";
import {
  encodeDrivePath,
  getDriveItemByPath,
  listDrives,
  replaceDriveFile,
  selectDrive,
  uploadNewDriveFile,
} from "../../src/graph/drive.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function urlString(input: unknown): string {
  return typeof input === "string" ? input : "";
}

describe("Graph drive helpers", () => {
  it("encodes drive paths segment by segment", () => {
    expect(encodeDrivePath("Reports/June Total.xlsx")).toBe("Reports/June%20Total.xlsx");
  });

  it("lists drives and selects by name or id", async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse(200, {
        value: [{ id: "drive-docs", name: "Documents", driveType: "documentLibrary" }],
      });
    const client = createGraphClient({ accessToken: "token", baseUrl: "http://graph", fetchFn });
    const drives = await listDrives(client, "site-1");

    expect(selectDrive(drives, "Documents").id).toBe("drive-docs");
    expect(selectDrive(drives, "drive-docs").name).toBe("Documents");
    expect(() => selectDrive(drives, "ghost")).toThrow(/not found/);
  });

  it("returns null when a path lookup is 404", async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse(404, { error: { code: "itemNotFound", message: "missing" } });
    const client = createGraphClient({ accessToken: "token", baseUrl: "http://graph", fetchFn });

    expect(await getDriveItemByPath(client, "drive", "missing.xlsx")).toBeNull();
  });

  it("creates through an upload session after a not-found preflight", async () => {
    const calls: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
    const fetchFn: FetchLike = async (input, init) => {
      calls.push({ url: urlString(input), init });
      if (calls.length === 1) {
        return jsonResponse(404, { error: { code: "itemNotFound", message: "missing" } });
      }
      if (calls.length === 2) {
        return jsonResponse(200, { uploadUrl: "http://upload/session" });
      }
      return jsonResponse(201, { id: "item-1", name: "book.xlsx", eTag: "etag-1", file: {} });
    };
    const client = createGraphClient({ accessToken: "token", baseUrl: "http://graph", fetchFn });

    const item = await uploadNewDriveFile(client, "drive", "Reports/book.xlsx", new Uint8Array([1, 2]));

    expect(item.id).toBe("item-1");
    expect(calls[1]?.url).toContain("createUploadSession");
    const headers = calls[2]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.["Content-Range"]).toBe("bytes 0-1/2");
    expect(headers?.["Authorization"]).toBeUndefined();
  });

  it("refuses to create when preflight finds an existing item", async () => {
    const fetchFn: FetchLike = async () => jsonResponse(200, { id: "existing", name: "book.xlsx", file: {} });
    const client = createGraphClient({ accessToken: "token", baseUrl: "http://graph", fetchFn });

    await expect(uploadNewDriveFile(client, "drive", "book.xlsx", new Uint8Array([1]))).rejects.toThrow(
      /Refusing to overwrite/,
    );
  });

  it("uses If-Match when replacing workbook content", async () => {
    let captured: RequestInit | undefined;
    const fetchFn: FetchLike = async (_input, init) => {
      captured = init;
      return jsonResponse(200, { id: "item", name: "book.xlsx", eTag: "new", file: {} });
    };
    const client = createGraphClient({ accessToken: "token", baseUrl: "http://graph", fetchFn });

    await replaceDriveFile(client, "drive", "book.xlsx", "old-etag", new Uint8Array([1]));

    const headers = captured?.headers as Record<string, string> | undefined;
    expect(headers?.["If-Match"]).toBe("old-etag");
  });

  it("surfaces GraphHttpError details", async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse(412, { error: { code: "preconditionFailed", message: "etag mismatch" } });
    const client = createGraphClient({ accessToken: "token", baseUrl: "http://graph", fetchFn });

    await expect(client.requestJson("/x")).rejects.toBeInstanceOf(GraphHttpError);
  });
});
