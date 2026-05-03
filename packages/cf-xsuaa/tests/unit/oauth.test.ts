import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import { fetchClientCredentialsToken } from "../../src/oauth/client-credentials.js";
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

  it("normalizes a trailing slash in the UAA URL", async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () =>
        await Promise.resolve(
          new Response(JSON.stringify({ access_token: "tok", token_type: "bearer", expires_in: 3600 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    );

    await fetchClientCredentialsToken({ ...creds, url: "https://uaa.example.com/" }, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://uaa.example.com/oauth/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws when response is not ok", async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () => await Promise.resolve(new Response("bad creds", { status: 401 })),
    );
    await expect(fetchClientCredentialsToken(creds, { fetchImpl })).rejects.toThrow(/401/);
  });

  it("throws with status when error response body is unreadable", async () => {
    const response = new Response(null, { status: 500 });
    vi.spyOn(response, "text").mockRejectedValue(new Error("body unavailable"));
    const fetchImpl: typeof fetch = vi.fn(async () => await Promise.resolve(response));

    await expect(fetchClientCredentialsToken(creds, { fetchImpl })).rejects.toThrow(/500/);
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

  it("throws when access_token is empty", async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () =>
        await Promise.resolve(
          new Response(JSON.stringify({ access_token: "", token_type: "bearer", expires_in: 3600 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    );
    await expect(fetchClientCredentialsToken(creds, { fetchImpl })).rejects.toThrow(/access_token/);
  });

  it("throws when access_token is not a string", async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () =>
        await Promise.resolve(
          new Response(JSON.stringify({ access_token: 123, token_type: "bearer", expires_in: 3600 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    );
    await expect(fetchClientCredentialsToken(creds, { fetchImpl })).rejects.toThrow(/access_token/);
  });

  it("throws when the token response is not JSON", async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () =>
        await Promise.resolve(
          new Response("not-json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    );
    await expect(fetchClientCredentialsToken(creds, { fetchImpl })).rejects.toThrow(SyntaxError);
  });

  it("propagates fetch failures without adding the client secret to the error", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => {
      throw new Error("network unavailable");
    });

    await expect(fetchClientCredentialsToken(creds, { fetchImpl })).rejects.not.toThrow(/secret/);
    await expect(fetchClientCredentialsToken(creds, { fetchImpl })).rejects.toThrow(/network unavailable/);
  });
});
