import { describe, expect, it } from "vitest";

import { acquireAppToken } from "../../src/auth.js";
import type { FetchLike } from "../../src/graph.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function urlString(input: unknown): string {
  return typeof input === "string" ? input : "";
}

function bodyString(body: unknown): string {
  return typeof body === "string" ? body : "";
}

describe("acquireAppToken", () => {
  const creds = { tenantId: "tid", clientId: "cid", clientSecret: "sec" };

  it("posts client_credentials and returns token info", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const fetchFn: FetchLike = async (input, init) => {
      capturedUrl = urlString(input);
      capturedBody = bodyString(init?.body);
      return jsonResponse(200, {
        access_token: "token-xyz",
        token_type: "Bearer",
        expires_in: 1800,
        scope: "https://graph.microsoft.com/.default",
      });
    };
    const info = await acquireAppToken(creds, {
      authBase: "http://fake-login",
      fetchFn,
    });
    expect(info.accessToken).toBe("token-xyz");
    expect(info.tokenType).toBe("Bearer");
    expect(info.scope).toContain("graph.microsoft.com");
    expect(info.expiresOn).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(capturedUrl).toContain("/tid/oauth2/v2.0/token");
    const params = new URLSearchParams(capturedBody);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe("cid");
    expect(params.get("client_secret")).toBe("sec");
    expect(params.get("scope")).toBe("https://graph.microsoft.com/.default");
  });

  it("omits scope when not returned", async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse(200, { access_token: "x", token_type: "Bearer", expires_in: 60 });
    const info = await acquireAppToken(creds, { authBase: "http://fake", fetchFn });
    expect(info.scope).toBeUndefined();
  });

  it("maps AAD error responses to a descriptive Error", async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse(401, { error: "invalid_client", error_description: "bad secret" });
    await expect(acquireAppToken(creds, { authBase: "http://fake", fetchFn })).rejects.toThrow(
      /invalid_client.*bad secret/,
    );
  });

  it("wraps non-JSON responses", async () => {
    const fetchFn: FetchLike = async () =>
      new Response("<html>nope</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      });
    await expect(acquireAppToken(creds, { authBase: "http://fake", fetchFn })).rejects.toThrow(
      /parse token response/,
    );
  });

  it("throws when access_token is missing", async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse(200, { token_type: "Bearer", expires_in: 10 });
    await expect(acquireAppToken(creds, { authBase: "http://fake", fetchFn })).rejects.toThrow(
      /access_token/,
    );
  });

  it("rejects empty credential values", async () => {
    const fetchFn: FetchLike = async () => jsonResponse(200, {});
    await expect(
      acquireAppToken({ tenantId: "", clientId: "c", clientSecret: "s" }, { fetchFn }),
    ).rejects.toThrow(/tenantId/);
    await expect(
      acquireAppToken({ tenantId: "t", clientId: "", clientSecret: "s" }, { fetchFn }),
    ).rejects.toThrow(/clientId/);
    await expect(
      acquireAppToken({ tenantId: "t", clientId: "c", clientSecret: "" }, { fetchFn }),
    ).rejects.toThrow(/clientSecret/);
  });
});
