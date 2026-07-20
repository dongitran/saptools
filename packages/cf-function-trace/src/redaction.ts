import process from "node:process";

import { defineOwnValue } from "./safe-record.js";

const REDACTED = { kind: "redacted" } as const;
// A project can list additional sensitive key names (business PII this
// package has no built-in knowledge of, e.g. employeeId/taxId) without a
// code change to this package by setting this comma-separated env var.
const EXTRA_SENSITIVE_KEYS_ENV = "CF_FUNCTION_TRACE_SENSITIVE_KEYS";
const EMAIL_PATTERN = /\b[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+\b/gu;
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

// Reads CF_FUNCTION_TRACE_SENSITIVE_KEYS fresh on every call (cheap: a short
// env var split) so a project can add domain-specific PII key names (e.g.
// employeeId, taxId, vendorBankAccount) purely through configuration.
//
// Only the WHOLE joined form of each configured entry is added, never its
// individual component words: unlike the curated built-in SENSITIVE_TOKENS
// (single generic words that are sensitive in isolation, e.g. "password"),
// a project-supplied multi-word key like "vendorBankAccount" is one specific
// field. Adding "vendor"/"bank"/"account" as independently sensitive tokens
// would also redact any unrelated field sharing just one of those words
// (accountBalance, bankName, vendorName, orderId, userId all share a token
// with employeeId/taxId/vendorBankAccount) -- exactly the collateral
// over-redaction a project configuring ITS OWN specific key never asked for.
// A single-word entry (e.g. "badge") still matches as a component of other
// compound keys (employeeBadge) because its joined form equals its one token.
function extraSensitiveKeyTokens(): ReadonlySet<string> {
  const raw = process.env[EXTRA_SENSITIVE_KEYS_ENV];
  const tokens = new Set<string>();
  if (raw === undefined) {
    return tokens;
  }
  for (const entry of raw.split(",")) {
    if (entry.trim().length === 0) {
      continue;
    }
    tokens.add(keyTokens(entry).join(""));
  }
  return tokens;
}

function isSensitiveKey(key: string, extraKeys: ReadonlySet<string>): boolean {
  const tokens = keyTokens(key);
  const joined = tokens.join("");
  return tokens.some((token) => SENSITIVE_TOKENS.has(token) || extraKeys.has(token))
    || SENSITIVE_TOKENS.has(joined)
    || extraKeys.has(joined);
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
  const withoutJwt = withoutAuth.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED]");
  return withoutJwt.replace(EMAIL_PATTERN, "[REDACTED]");
}

function redactRecord(value: object, seen: WeakSet<object>, extraKeys: ReadonlySet<string>): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    defineOwnValue(output, key, isSensitiveKey(key, extraKeys) ? REDACTED : redactUnknown(child, seen, extraKeys));
  }
  return output;
}

function redactUnknown(value: unknown, seen: WeakSet<object>, extraKeys: ReadonlySet<string>): unknown {
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
    return value.map((child) => redactUnknown(child, seen, extraKeys));
  }
  return redactRecord(value, seen, extraKeys);
}

export function redactValue(value: unknown): unknown {
  return redactUnknown(value, new WeakSet<object>(), extraSensitiveKeyTokens());
}
