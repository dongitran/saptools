import { readFileSync } from "node:fs";

import { RE2JS } from "re2js";

interface RegexWorkerRequest {
  readonly pattern: string;
  readonly candidates: readonly string[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequest(value: unknown): RegexWorkerRequest | undefined {
  if (!isRecord(value) || typeof value["pattern"] !== "string" || value["pattern"].length > 256) {
    return undefined;
  }
  const candidates = value["candidates"];
  return Array.isArray(candidates) && candidates.every((candidate) => typeof candidate === "string")
    ? { pattern: value["pattern"], candidates }
    : undefined;
}

function writeResponse(response: Readonly<Record<string, unknown>>): void {
  process.stdout.write(JSON.stringify(response));
}

function run(): void {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    writeResponse({ status: "error" });
    return;
  }
  const request = parseRequest(value);
  if (request === undefined) {
    writeResponse({ status: "error" });
    return;
  }
  try {
    const regex = RE2JS.compile(request.pattern, RE2JS.CASE_INSENSITIVE | RE2JS.LOOKBEHINDS);
    const matches = request.candidates.map((candidate) => regex.test(candidate) ? "1" : "0").join("");
    writeResponse({ status: "ok", matches });
  } catch {
    writeResponse({ status: "error" });
  }
}

run();
