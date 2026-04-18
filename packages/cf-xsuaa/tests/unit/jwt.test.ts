import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { computeExpiryIso, decodeJwtPayload, isExpired, TOKEN_EXPIRY_BUFFER_SECONDS } from "../../src/jwt.js";

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${encode({ alg: "HS256" })}.${encode(payload)}.signature`;
}

describe("decodeJwtPayload", () => {
  it("decodes a JWT body", () => {
    const jwt = makeJwt({ exp: 123, foo: "bar" });
    expect(decodeJwtPayload(jwt)).toMatchObject({ exp: 123, foo: "bar" });
  });

  it("handles base64url without padding", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "x" })).toString("base64url");
    const jwt = `header.${payload}.sig`;
    expect(decodeJwtPayload(jwt)).toEqual({ sub: "x" });
  });

  it("throws for malformed JWT", () => {
    expect(() => decodeJwtPayload("just-one-part")).toThrow(/Invalid JWT/);
  });

  it("throws for empty payload segment", () => {
    expect(() => decodeJwtPayload("h..s")).toThrow(/empty payload/);
  });
});

describe("computeExpiryIso", () => {
  it("uses exp field minus buffer", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = makeJwt({ exp });
    const iso = computeExpiryIso(jwt);
    expect(new Date(iso).getTime()).toBeCloseTo((exp - TOKEN_EXPIRY_BUFFER_SECONDS) * 1000, -2);
  });

  it("falls back to now + 1h - buffer when exp missing", () => {
    const now = new Date("2026-04-18T00:00:00.000Z");
    const jwt = makeJwt({});
    const iso = computeExpiryIso(jwt, now);
    const expected = new Date(now.getTime() + (3600 - TOKEN_EXPIRY_BUFFER_SECONDS) * 1000).toISOString();
    expect(iso).toBe(expected);
  });
});

describe("isExpired", () => {
  it("returns true for past timestamps", () => {
    expect(isExpired("2000-01-01T00:00:00.000Z")).toBe(true);
  });

  it("returns false for future timestamps", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(isExpired(future)).toBe(false);
  });

  it("returns true for invalid strings", () => {
    expect(isExpired("not-a-date")).toBe(true);
  });
});
