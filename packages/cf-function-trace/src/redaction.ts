import { defineOwnValue } from "./safe-record.js";

const REDACTED = { kind: "redacted" } as const;
const API_KEY_TOKEN = ["api", "key"].join("");
const CONNECTION_STRING_TOKEN = ["connection", "string"].join("");
const SENSITIVE_TOKENS = new Set([
  "authorization",
  "certificate",
  "clientsecret",
  CONNECTION_STRING_TOKEN,
  "cookie",
  "credential",
  "key",
  "password",
  "passphrase",
  "passwd",
  "privatekey",
  "pwd",
  "secret",
  "token",
]);
const SENSITIVE_ASSIGNMENTS = [
  "access token",
  API_KEY_TOKEN,
  "api key",
  "clientsecret",
  "client secret",
  "password",
  "passphrase",
  "passwd",
  "pwd",
  "key",
  "connection_string",
  "connection-string",
  "secret",
  "token",
] as const;

function keyTokens(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

function isSensitiveKey(key: string): boolean {
  const tokens = keyTokens(key);
  const joined = tokens.join("");
  return tokens.some((token) => SENSITIVE_TOKENS.has(token)) || SENSITIVE_TOKENS.has(joined);
}

function redactUrlUserInfo(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.username.length === 0 && parsed.password.length === 0) {
      return undefined;
    }
    parsed.username = "redacted";
    parsed.password = "redacted";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function hasAssignmentBoundary(value: string, index: number, keyLength: number): boolean {
  const before = index === 0 ? "" : value[index - 1] ?? "";
  if (/[a-z0-9]/u.test(before)) {
    return false;
  }
  let cursor = index + keyLength;
  while (cursor < value.length && /\s/u.test(value[cursor] ?? "")) {
    cursor += 1;
  }
  return value[cursor] === "=" || value[cursor] === ":";
}

function hasSensitiveAssignment(value: string): boolean {
  const lower = value.toLowerCase();
  for (const key of SENSITIVE_ASSIGNMENTS) {
    let index = lower.indexOf(key);
    while (index >= 0) {
      if (hasAssignmentBoundary(lower, index, key.length)) {
        return true;
      }
      index = lower.indexOf(key, index + key.length);
    }
  }
  return false;
}

function redactJdbcUserInfo(value: string): string | undefined {
  if (!value.toLowerCase().startsWith("jdbc:")) {
    return undefined;
  }
  const redacted = redactUrlUserInfo(value.slice(5));
  return redacted === undefined ? undefined : `jdbc:${redacted}`;
}

function redactString(value: string): unknown {
  if (/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/u.test(value)) {
    return REDACTED;
  }
  const redactedJdbc = redactJdbcUserInfo(value);
  if (redactedJdbc !== undefined) {
    return redactedJdbc;
  }
  if (hasSensitiveAssignment(value)) {
    return REDACTED;
  }
  const redactedUrl = redactUrlUserInfo(value);
  if (redactedUrl !== undefined) {
    return redactedUrl;
  }
  const withoutAuth = value.replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/giu, "[REDACTED]");
  return withoutAuth.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED]");
}

function redactRecord(value: object, seen: WeakSet<object>): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    defineOwnValue(output, key, isSensitiveKey(key) ? REDACTED : redactUnknown(child, seen));
  }
  return output;
}

function redactUnknown(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return { kind: "unavailable", description: "cyclic-input" };
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((child) => redactUnknown(child, seen));
  }
  return redactRecord(value, seen);
}

export function redactValue(value: unknown): unknown {
  return redactUnknown(value, new WeakSet<object>());
}
