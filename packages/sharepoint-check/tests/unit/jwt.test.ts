import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { decodeAccessToken } from "../../src/auth/jwt.js";

function base64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replaceAll("=", "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

function encodeJwt(payload: Record<string, unknown>): string {
  return `${base64Url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${base64Url(JSON.stringify(payload))}.sig`;
}

describe("decodeAccessToken", () => {
  it("extracts appid, roles, tenantId, scopes, and timestamps", () => {
    const token = encodeJwt({
      appid: "app-42",
      app_displayname: "Demo",
      tid: "tenant-99",
      roles: ["Files.ReadWrite.All", "Sites.Selected"],
      scp: "User.Read openid",
      iat: 1700000000,
      exp: 1700003600,
    });

    const decoded = decodeAccessToken(token);
    expect(decoded.appId).toBe("app-42");
    expect(decoded.appDisplayName).toBe("Demo");
    expect(decoded.tenantId).toBe("tenant-99");
    expect(decoded.roles).toEqual(["Files.ReadWrite.All", "Sites.Selected"]);
    expect(decoded.scopes).toEqual(["User.Read", "openid"]);
    expect(decoded.issuedAt).toBe(1700000000);
    expect(decoded.expiresAt).toBe(1700003600);
  });

  it("defaults missing fields to undefined/empty", () => {
    const token = encodeJwt({});
    const decoded = decodeAccessToken(token);
    expect(decoded.appId).toBeUndefined();
    expect(decoded.roles).toEqual([]);
    expect(decoded.scopes).toEqual([]);
  });

  it("ignores non-string entries inside roles array", () => {
    const token = encodeJwt({ roles: ["Sites.Selected", 7, null] });
    expect(decodeAccessToken(token).roles).toEqual(["Sites.Selected"]);
  });

  it("rejects tokens without a payload segment", () => {
    expect(() => decodeAccessToken("onlyone")).toThrow(/valid JWT/);
  });

  it("rejects tokens with empty payload segments", () => {
    expect(() => decodeAccessToken("header..sig")).toThrow(/valid JWT/);
  });

  it("rejects tokens whose payload is not JSON", () => {
    const token = `${base64Url("header")}.${base64Url("not json")}.sig`;
    expect(() => decodeAccessToken(token)).toThrow(/decode JWT payload/);
  });
});
