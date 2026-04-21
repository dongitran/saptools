import { Buffer } from "node:buffer";

import type { DecodedTokenClaims } from "./types.js";

interface RawClaims {
  readonly appid?: unknown;
  readonly app_displayname?: unknown;
  readonly tid?: unknown;
  readonly roles?: unknown;
  readonly scp?: unknown;
  readonly exp?: unknown;
  readonly iat?: unknown;
}

function base64UrlDecode(segment: string): string {
  const padLength = (4 - (segment.length % 4)) % 4;
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLength);
  return Buffer.from(normalized, "base64").toString("utf8");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof value === "string" && value.length > 0) {
    return value.split(/\s+/).filter((entry) => entry.length > 0);
  }

  return [];
}

export function decodeAccessToken(token: string): DecodedTokenClaims {
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("Access token is not a valid JWT (missing payload segment)");
  }

  const payloadSegment = parts[1];
  if (payloadSegment === undefined || payloadSegment.length === 0) {
    throw new Error("Access token is not a valid JWT (empty payload segment)");
  }

  let raw: RawClaims;
  try {
    raw = JSON.parse(base64UrlDecode(payloadSegment)) as RawClaims;
  } catch (err) {
    throw new Error(
      `Failed to decode JWT payload: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const claims: DecodedTokenClaims = {
    appId: asString(raw.appid),
    appDisplayName: asString(raw.app_displayname),
    tenantId: asString(raw.tid),
    roles: asStringArray(raw.roles),
    scopes: asStringArray(raw.scp),
    expiresAt: asNumber(raw.exp),
    issuedAt: asNumber(raw.iat),
  };

  return claims;
}
