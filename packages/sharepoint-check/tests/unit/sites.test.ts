import { describe, expect, it } from "vitest";

import type { GraphClient } from "../../src/graph.js";
import { GraphHttpError } from "../../src/graph.js";
import { parseSiteRef, resolveSite } from "../../src/sites.js";

describe("parseSiteRef", () => {
  it("parses host/sites/name", () => {
    expect(parseSiteRef("contoso.sharepoint.com/sites/demo")).toEqual({
      hostname: "contoso.sharepoint.com",
      sitePath: "sites/demo",
    });
  });

  it("tolerates https:// prefix and trailing slash", () => {
    expect(parseSiteRef("https://contoso.sharepoint.com/sites/demo/")).toEqual({
      hostname: "contoso.sharepoint.com",
      sitePath: "sites/demo",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseSiteRef("  https://contoso.sharepoint.com/sites/team  ")).toEqual({
      hostname: "contoso.sharepoint.com",
      sitePath: "sites/team",
    });
  });

  it("throws for empty input", () => {
    expect(() => parseSiteRef("  ")).toThrow(/empty/);
  });

  it("throws when there is no slash", () => {
    expect(() => parseSiteRef("contoso.sharepoint.com")).toThrow(/Invalid site reference/);
  });

  it("throws when path is empty", () => {
    expect(() => parseSiteRef("contoso.sharepoint.com/")).toThrow(/Missing site path/);
  });

  it("throws when host is empty", () => {
    expect(() => parseSiteRef("/sites/demo")).toThrow(/Missing hostname/);
  });
});

describe("resolveSite", () => {
  function fakeClient(payload: Readonly<Record<string, unknown>>, captured: string[]): GraphClient {
    return {
      baseUrl: "https://graph",
      request: async <T>(path: string): Promise<T> => {
        captured.push(path);
        return payload as T;
      },
    };
  }

  it("calls the /sites/{host}:/{path} endpoint and maps fields", async () => {
    const captured: string[] = [];
    const client = fakeClient(
      { id: "site-1", name: "demo", displayName: "Demo", webUrl: "https://x" },
      captured,
    );
    const site = await resolveSite(client, { hostname: "h.example", sitePath: "sites/demo" });
    expect(captured[0]).toBe("/sites/h.example:/sites/demo");
    expect(site.id).toBe("site-1");
    expect(site.displayName).toBe("Demo");
  });

  it("encodes each site path segment", async () => {
    const captured: string[] = [];
    const client = fakeClient({ id: "site-1", name: "space" }, captured);
    await resolveSite(client, { hostname: "h.example", sitePath: "sites/space name" });
    expect(captured[0]).toBe("/sites/h.example:/sites/space%20name");
  });

  it("falls back display names to name and then path", async () => {
    const named = await resolveSite(fakeClient({ id: "site-1", name: "Team" }, []), {
      hostname: "h.example",
      sitePath: "sites/team",
    });
    expect(named.displayName).toBe("Team");

    const pathNamed = await resolveSite(fakeClient({ id: "site-2" }, []), {
      hostname: "h.example",
      sitePath: "sites/path-only",
    });
    expect(pathNamed.name).toBe("sites/path-only");
    expect(pathNamed.displayName).toBe("sites/path-only");
  });

  it("throws when the response lacks an id", async () => {
    const client = fakeClient({ name: "demo" }, []);
    await expect(resolveSite(client, { hostname: "h", sitePath: "sites/x" })).rejects.toThrow(
      /missing id/,
    );
  });

  it("translates 404 into a helpful hint", async () => {
    const client: GraphClient = {
      baseUrl: "https://graph",
      request: async <T>(): Promise<T> => {
        throw new GraphHttpError(404, "itemNotFound", "site not found");
      },
    };
    await expect(
      resolveSite(client, { hostname: "h.example", sitePath: "sites/nope" }),
    ).rejects.toThrow(/SharePoint site not found/);
  });

  it("propagates non-404 errors unchanged", async () => {
    const original = new GraphHttpError(500, "internalError", "boom");
    const client: GraphClient = {
      baseUrl: "https://graph",
      request: async <T>(): Promise<T> => {
        throw original;
      },
    };
    await expect(
      resolveSite(client, { hostname: "h", sitePath: "sites/x" }),
    ).rejects.toBe(original);
  });
});
