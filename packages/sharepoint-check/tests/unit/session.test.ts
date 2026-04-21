import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import type { FetchLike } from "../../src/graph.js";
import { openSession } from "../../src/session.js";
import type { SharePointTarget } from "../../src/types.js";

function base64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replaceAll("=", "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

function encodeToken(payload: Record<string, unknown>): string {
  return `${base64Url(JSON.stringify({ alg: "none" }))}.${base64Url(JSON.stringify(payload))}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("openSession", () => {
  const target: SharePointTarget = {
    credentials: { tenantId: "t", clientId: "c", clientSecret: "s" },
    site: { hostname: "h.example", sitePath: "sites/demo" },
  };

  it("orchestrates token → decode → site lookup", async () => {
    const calls: string[] = [];
    const token = encodeToken({ appid: "a", roles: ["Sites.Selected"], tid: "t" });
    const fetchFn: FetchLike = async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      calls.push(url);
      if (url.endsWith("/oauth2/v2.0/token")) {
        return jsonResponse({ access_token: token, token_type: "Bearer", expires_in: 60 });
      }
      return jsonResponse({ id: "site-1", name: "demo", displayName: "Demo", webUrl: "http://x" });
    };

    const session = await openSession(target, {
      authBase: "http://fake-login",
      graphBase: "http://fake-graph",
      fetchFn,
    });

    expect(session.token.tokenType).toBe("Bearer");
    expect(session.claims.roles).toEqual(["Sites.Selected"]);
    expect(session.site.id).toBe("site-1");
    expect(calls[0]).toContain("oauth2");
    expect(calls[1]).toContain("/sites/h.example:");
  });
});
