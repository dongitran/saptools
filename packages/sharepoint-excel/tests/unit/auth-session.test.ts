import { describe, expect, it } from "vitest";

import { acquireAppToken } from "../../src/auth/token.js";
import type { FetchLike } from "../../src/graph/client.js";
import { openSession } from "../../src/session.js";
import type { SharePointTarget } from "../../src/types.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function target(): SharePointTarget {
  return {
    credentials: { tenantId: "tenant", clientId: "client", clientSecret: "secret" },
    site: { hostname: "demo.sharepoint.example", sitePath: "sites/demo" },
  };
}

function requestUrl(input: Parameters<FetchLike>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

describe("acquireAppToken", () => {
  it("requests a client credentials token", async () => {
    let capturedBody = "";
    const fetchFn: FetchLike = async (_input, init) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return jsonResponse(200, {
        access_token: "token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "scope-value",
      });
    };

    const token = await acquireAppToken(target().credentials, {
      authBase: "http://auth",
      fetchFn,
    });

    expect(token.accessToken).toBe("token");
    expect(token.scope).toBe("scope-value");
    expect(capturedBody).toContain("client_id=client");
    expect(capturedBody).toContain("client_secret=secret");
  });

  it("validates required credentials and token shape", async () => {
    await expect(
      acquireAppToken({ tenantId: "", clientId: "client", clientSecret: "secret" }),
    ).rejects.toThrow(/tenantId/);
    const fetchFn: FetchLike = async () => jsonResponse(200, { token_type: "Bearer", expires_in: 3600 });
    await expect(
      acquireAppToken(target().credentials, { authBase: "http://auth", fetchFn }),
    ).rejects.toThrow(/access_token/);
  });

  it("reports unparseable token responses", async () => {
    const fetchFn: FetchLike = async () =>
      new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } });
    await expect(
      acquireAppToken(target().credentials, { authBase: "http://auth", fetchFn }),
    ).rejects.toThrow(/Failed to parse token/);
  });

  it("throws a redacted token error", async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse(401, { error: "invalid_client", error_description: "bad secret" });

    await expect(
      acquireAppToken(target().credentials, { authBase: "http://auth", fetchFn }),
    ).rejects.toThrow(/invalid_client/);
  });
});

describe("openSession", () => {
  it("opens token, site, and drive state with one fetch override", async () => {
    const fetchFn: FetchLike = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/oauth2/v2.0/token")) {
        return jsonResponse(200, {
          access_token: "token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (url.includes("/sites/demo.sharepoint.example:/sites/demo")) {
        return jsonResponse(200, {
          id: "site-1",
          name: "demo",
          displayName: "Demo Site",
          webUrl: "https://demo",
        });
      }
      if (url.endsWith("/sites/site-1/drives")) {
        return jsonResponse(200, {
          value: [{ id: "drive-1", name: "Documents", driveType: "documentLibrary" }],
        });
      }
      return jsonResponse(404, { error: { code: "itemNotFound", message: url } });
    };

    const session = await openSession(target(), {
      authBase: "http://auth",
      graphBase: "http://graph/v1.0",
      fetchFn,
    });

    expect(session.site.displayName).toBe("Demo Site");
    expect(session.drives[0]?.name).toBe("Documents");
  });

  it("opens with default option branches and env auth base", async () => {
    const fetchFn: FetchLike = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/oauth2/v2.0/token")) {
        return jsonResponse(200, { access_token: "token", token_type: "Bearer", expires_in: 3600 });
      }
      if (url.includes("/sites/demo.sharepoint.example:/sites/demo")) {
        return jsonResponse(200, { id: "site-1", name: "demo" });
      }
      return jsonResponse(200, { value: [] });
    };

    const token = await acquireAppToken(target().credentials, {
      fetchFn,
      env: { SHAREPOINT_EXCEL_AUTH_BASE: "http://env-auth" },
    });
    const session = await openSession(target(), { fetchFn });

    expect(token.accessToken).toBe("token");
    expect(session.drives).toEqual([]);
  });
});
