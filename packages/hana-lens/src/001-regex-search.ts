import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { RE2JS } from "re2js";

const REGEX_TIMEOUT_MS = 250;
const REGEX_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const WORKER_PATH = fileURLToPath(new URL("./002-regex-worker.js", import.meta.url));

type RegexWorkerResponse =
  | { readonly status: "ok"; readonly matches: readonly boolean[] }
  | { readonly status: "invalid"; readonly message: string };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMatchBits(value: unknown, candidateCount: number): readonly boolean[] | undefined {
  if (typeof value !== "string" || value.length !== candidateCount) {
    return undefined;
  }
  const matches: boolean[] = [];
  for (const bit of value) {
    if (bit !== "0" && bit !== "1") {
      return undefined;
    }
    matches.push(bit === "1");
  }
  return matches;
}

function parseWorkerResponse(raw: string, candidateCount: number): RegexWorkerResponse | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  if (parsed["status"] === "invalid" && typeof parsed["message"] === "string") {
    return { status: "invalid", message: parsed["message"] };
  }
  const matches = parseMatchBits(parsed["matches"], candidateCount);
  return parsed["status"] === "ok" && matches !== undefined
    ? { status: "ok", matches }
    : undefined;
}

function matchWithLinearEngine(pattern: string, candidates: readonly string[]): readonly boolean[] {
  try {
    const regex = RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE | RE2JS.LOOKBEHINDS);
    return candidates.map((candidate) => regex.test(candidate));
  } catch {
    throw new Error("Regex evaluation exceeded the safe time limit");
  }
}

function isTimeoutError(error: Error | undefined): boolean {
  return error !== undefined && "code" in error && error.code === "ETIMEDOUT";
}

export function matchRegexCandidates(pattern: string, candidates: readonly string[]): readonly boolean[] {
  const result = spawnSync(process.execPath, [WORKER_PATH], {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
    input: JSON.stringify({ pattern, candidates }),
    killSignal: "SIGKILL",
    maxBuffer: REGEX_MAX_BUFFER_BYTES,
    shell: false,
    timeout: REGEX_TIMEOUT_MS,
    windowsHide: true,
  });
  if (isTimeoutError(result.error)) {
    return matchWithLinearEngine(pattern, candidates);
  }
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error("Regex evaluation failed");
  }
  const response = parseWorkerResponse(result.stdout, candidates.length);
  if (response?.status === "invalid") {
    throw new SyntaxError(response.message);
  }
  if (response?.status !== "ok") {
    throw new Error("Regex evaluation returned an invalid response");
  }
  return response.matches;
}
