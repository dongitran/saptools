import { isAbsolute } from "node:path";

import { TraceDataError } from "./errors.js";

const RUN_ID_PATTERN = /^t[0-9a-f]{16}$/;
const SELECTOR_PATTERN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/u;
const MAX_SELECTOR_LENGTH = 256;
const MAX_RUNTIME_FILE_LENGTH = 4096;

export function validateRunId(value: string): string {
  if (!RUN_ID_PATTERN.test(value)) {
    throw new TraceDataError("INVALID_RUN_ID", "Run ID must match t followed by 16 lowercase hexadecimal characters.");
  }
  return value;
}

export function validateFunctionSelector(value: string): string {
  const selector = value.trim();
  if (selector.length === 0 || selector.length > MAX_SELECTOR_LENGTH || !SELECTOR_PATTERN.test(selector)) {
    throw new TraceDataError("INVALID_SELECTOR", "Function selector must be a bare or one-level qualified JavaScript identifier.");
  }
  return selector;
}

export function validateRuntimeFile(value: string): string {
  const file = value.trim();
  const isFileUrl = file.startsWith("file://");
  const hasTraversalSegment = file.replaceAll("\\", "/").split("/").includes("..");
  if (file.length === 0 || file.length > MAX_RUNTIME_FILE_LENGTH || file.includes("\0")) {
    throw new TraceDataError("INVALID_RUNTIME_FILE", "Runtime file is empty, too long, or contains a null byte.");
  }
  if (!isFileUrl && !isAbsolute(file) && hasTraversalSegment) {
    throw new TraceDataError("INVALID_RUNTIME_FILE", "Runtime file traversal is not allowed.");
  }
  return file;
}

export function parsePositiveInteger(raw: string, label: string, maximum: number): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || value > maximum || String(value) !== raw) {
    throw new TraceDataError("INVALID_ARGUMENT", `${label} must be an integer between 1 and ${String(maximum)}.`);
  }
  return value;
}
