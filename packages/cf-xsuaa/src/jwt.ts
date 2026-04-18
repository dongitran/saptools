import { Buffer } from "node:buffer";

export interface JwtPayload {
  readonly exp?: number;
  readonly iat?: number;
  readonly iss?: string;
  readonly aud?: string | readonly string[];
}

export function decodeJwtPayload(jwt: string): JwtPayload {
  const parts = jwt.split(".");
  if (parts.length < 2) {
    throw new Error("Invalid JWT format: expected header.payload.signature");
  }
  const payload = parts[1];
  if (payload === undefined || payload.length === 0) {
    throw new Error("Invalid JWT: empty payload");
  }
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const json = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(json) as JwtPayload;
}

export const TOKEN_EXPIRY_BUFFER_SECONDS = 45;

export function computeExpiryIso(jwt: string, now: Date = new Date()): string {
  const payload = decodeJwtPayload(jwt);
  if (typeof payload.exp === "number") {
    const expiryMs = (payload.exp - TOKEN_EXPIRY_BUFFER_SECONDS) * 1000;
    return new Date(expiryMs).toISOString();
  }
  const fallback = new Date(now.getTime() + (3600 - TOKEN_EXPIRY_BUFFER_SECONDS) * 1000);
  return fallback.toISOString();
}

export function isExpired(expiresAt: string, now: Date = new Date()): boolean {
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) {
    return true;
  }
  return t <= now.getTime();
}
