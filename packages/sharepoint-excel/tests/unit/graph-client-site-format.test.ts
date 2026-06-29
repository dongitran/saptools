import { describe, expect, it } from "vitest";

import { createGraphClient, GraphHttpError } from "../../src/graph/client.js";
import type { FetchLike } from "../../src/graph/client.js";
import { parseSiteRef, resolveSite } from "../../src/graph/site.js";
import {
  formatCreateResult,
  formatDriveList,
  formatMutationResult,
  formatProfile,
  formatTestResult,
  formatWorkbookSheets,
} from "../../src/output/format.js";
import type { RemoteMutationResult, RemoteWorkbookResult } from "../../src/workbook/service.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: Parameters<FetchLike>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

describe("Graph client", () => {
  it("sends headers, retries 429, and reads JSON", async () => {
    const urls: string[] = [];
    const sleeps: number[] = [];
    const fetchFn: FetchLike = async (input) => {
      urls.push(requestUrl(input));
      if (urls.length === 1) {
        return new Response("slow", { status: 429, headers: { "retry-after": "1" } });
      }
      return jsonResponse(200, { ok: true });
    };
    const client = createGraphClient({
      accessToken: "token",
      baseUrl: "http://graph",
      fetchFn,
      retry: { sleepFn: async (ms) => { sleeps.push(ms); } },
    });

    await expect(client.requestJson("/ping")).resolves.toEqual({ ok: true });
    expect(urls).toEqual(["http://graph/ping", "http://graph/ping"]);
    expect(sleeps).toEqual([1000]);
  });

  it("reads bytes and no-content responses", async () => {
    const fetchFn: FetchLike = async () => new Response(new Uint8Array([1, 2]), { status: 200 });
    const client = createGraphClient({ accessToken: "token", baseUrl: "http://graph", fetchFn });

    expect([...await client.requestBytes("/content")]).toEqual([1, 2]);
    await expect(client.requestNoContent("/content")).resolves.toBeUndefined();
  });

  it("uses env base URLs, absolute URLs, and text error fallback", async () => {
    const fetchFn: FetchLike = async (input) => {
      if (requestUrl(input).endsWith("/fail")) {
        return new Response("plain failure", { status: 500 });
      }
      return jsonResponse(200, { ok: true });
    };
    const client = createGraphClient({
      accessToken: "token",
      fetchFn,
      env: { SHAREPOINT_EXCEL_GRAPH_BASE: "http://env-graph/" },
    });

    await expect(client.requestJson("http://absolute/ping")).resolves.toEqual({ ok: true });
    await expect(client.requestJson("/fail")).rejects.toMatchObject({ detail: "plain failure" });
    expect(client.baseUrl).toBe("http://env-graph");
  });

  it("handles string bodies, non-json success, and retry date headers", async () => {
    let attempts = 0;
    let capturedBody: unknown;
    const fetchFn: FetchLike = async (_input, init) => {
      attempts += 1;
      capturedBody = init?.body;
      if (attempts === 1) {
        return new Response("slow", {
          status: 503,
          headers: { "retry-after": new Date(Date.now() + 1).toUTCString() },
        });
      }
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    };
    const client = createGraphClient({
      accessToken: "token",
      baseUrl: "http://graph///",
      fetchFn,
      retry: { sleepFn: async () => undefined },
    });

    await expect(client.requestJson("/post", { method: "POST", body: "raw" })).resolves.toBeUndefined();
    expect(capturedBody).toBe("raw");
    expect(client.baseUrl).toBe("http://graph");
  });

  it("throws parsed GraphHttpError", async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse(500, { error: { code: "serverError", message: "boom" } });
    const client = createGraphClient({ accessToken: "token", baseUrl: "http://graph", fetchFn });

    await expect(client.requestJson("/x")).rejects.toBeInstanceOf(GraphHttpError);
  });
});

describe("site and format helpers", () => {
  it("parses and resolves a copied SharePoint URL", async () => {
    const ref = parseSiteRef("https://demo.sharepoint.example/sites/demo?view=1#top");
    const fetchFn: FetchLike = async () =>
      jsonResponse(200, { id: "site", name: "demo", displayName: "Demo Site", webUrl: "https://demo" });
    const site = await resolveSite(
      createGraphClient({ accessToken: "token", baseUrl: "http://graph", fetchFn }),
      ref,
    );

    expect(ref).toEqual({ hostname: "demo.sharepoint.example", sitePath: "sites/demo" });
    expect(site.displayName).toBe("Demo Site");
  });

  it("rejects invalid site refs and rewrites 404s with context", async () => {
    expect(() => parseSiteRef("contoso.sharepoint.example")).toThrow(/Expected/);
    const fetchFn: FetchLike = async () =>
      jsonResponse(404, { error: { code: "itemNotFound", message: "missing" } });
    await expect(
      resolveSite(
        createGraphClient({ accessToken: "token", baseUrl: "http://graph", fetchFn }),
        { hostname: "demo.sharepoint.example", sitePath: "sites/missing" },
      ),
    ).rejects.toThrow(/SharePoint site not found/);
  });

  it("formats common human-readable output", () => {
    expect(formatDriveList([])).toBe("(no drives found)");
    expect(formatDriveList([{ id: "d", name: "Documents", driveType: "documentLibrary", webUrl: "" }]))
      .toContain("Documents");
    expect(formatProfile({
      name: "default",
      tenantId: "tenant",
      clientId: "demo...user",
      site: "demo",
      secretStore: "keyring",
      updatedAt: "now",
      hasClientSecret: true,
    })).toContain("Client secret: stored");
    expect(formatWorkbookSheets({
      sheets: [{ name: "Orders", rowCount: 2, columnCount: 3, rows: [] }],
    })).toBe("Orders: 2 row(s), 3 column(s)");
    expect(formatTestResult({ id: "site", name: "demo", displayName: "Demo", webUrl: "" }, []))
      .toContain("Document libraries: 0");

    const created: RemoteWorkbookResult = {
      driveId: "drive",
      driveName: "Documents",
      path: "Reports/book.xlsx",
      item: { id: "item", name: "book.xlsx", isFolder: false, size: 1 },
    };
    expect(formatCreateResult(created)).toContain("Reports/book.xlsx");
    const mutated: RemoteMutationResult = {
      ...created,
      mutation: { bytes: new Uint8Array([1]), sheetName: "Orders", rowCount: 2, columnCount: 2 },
    };
    expect(formatMutationResult("Updated", mutated)).toContain("2 row(s)");
  });
});
