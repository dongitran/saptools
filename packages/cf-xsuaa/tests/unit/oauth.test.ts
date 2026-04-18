import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import { fetchClientCredentialsToken } from "../../src/oauth.js";
import type { XsuaaCredentials } from "../../src/types.js";

const creds: XsuaaCredentials = {
  clientId: "client",
  clientSecret: "secret",
  url: "https://uaa.example.com",
};

describe("fetchClientCredentialsToken", () => {
  it("POSTs to /oauth/token with Basic auth and client_credentials", async () => {
    const fetchImpl: typeof fetch = vi.fn(async (input, init = {}) => {
      expect(String(input)).toBe("https://uaa.example.com/oauth/token");
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      const expectedAuth = `Basic ${Buffer.from("client:secret").toString("base64")}`;
      expect(headers["authorization"]).toBe(expectedAuth);
      expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
      expect(init.body).toBe("grant_type=client_credentials");
      return await Promise.resolve(
        new Response(
          JSON.stringify({ access_token: "tok-123", token_type: "bearer", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    const token = await fetchClientCredentialsToken(creds, { fetchImpl });
    expect(token).toBe("tok-123");
  });

  it("throws when response is not ok", async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () => await Promise.resolve(new Response("bad creds", { status: 401 })),
    );
    await expect(fetchClientCredentialsToken(creds, { fetchImpl })).rejects.toThrow(/401/);
  });

  it("throws when access_token missing", async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () =>
        await Promise.resolve(
          new Response(JSON.stringify({ token_type: "bearer", expires_in: 3600 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    );
    await expect(fetchClientCredentialsToken(creds, { fetchImpl })).rejects.toThrow(/access_token/);
  });
});
