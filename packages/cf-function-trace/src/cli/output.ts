import type { Writable } from "node:stream";

import { TraceDataError } from "../errors.js";
import { redactValue } from "../redaction.js";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "string"
    ? String(Reflect.get(error, "code"))
    : undefined;
}

// Shared with query-commands.ts's own shrink-to-fit degrade for state/diff
// responses, so both use exactly the same redact-then-measure byte count
// that this module's own bounded write uses -- a candidate that "fits" here
// is guaranteed to fit through writeJsonOutput below too.
export function measureJsonBytes(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(redactValue(value))}\n`);
}

function boundedPayload(value: unknown, maxBytes: number): string {
  if (!Number.isInteger(maxBytes) || maxBytes < 128) {
    throw new TraceDataError("INVALID_ARGUMENT", "Output budget must be at least 128 bytes.");
  }
  const text = `${JSON.stringify(redactValue(value))}\n`;
  const originalBytes = Buffer.byteLength(text);
  if (originalBytes <= maxBytes) {
    return text;
  }
  const summary = `${JSON.stringify({ truncated: true, originalBytes })}\n`;
  if (Buffer.byteLength(summary) > maxBytes) {
    throw new TraceDataError("INVALID_ARGUMENT", "Output budget is too small for truncation metadata.");
  }
  return summary;
}

function settleWrite(
  stream: Writable,
  payload: string,
  resolve: (written: boolean) => void,
  reject: (error: Error) => void,
): void {
  let settled = false;
  const finish = (error?: Error | null): void => {
    if (settled) {
      return;
    }
    settled = true;
    stream.off("error", finish);
    if (errorCode(error) === "EPIPE") {
      resolve(false);
    } else if (error instanceof Error) {
      reject(error);
    } else {
      resolve(true);
    }
  };
  stream.once("error", finish);
  try {
    stream.write(payload, (error?: Error | null): void => {
      if (error === undefined || error === null) {
        finish();
      }
    });
  } catch (error: unknown) {
    finish(error instanceof Error ? error : new Error("Output stream failed"));
  }
}

export async function writeJsonOutput(
  stream: Writable,
  value: unknown,
  maxBytes: number,
): Promise<boolean> {
  const payload = boundedPayload(value, maxBytes);
  return await new Promise<boolean>((resolve, reject) => {
    settleWrite(stream, payload, resolve, reject);
  });
}
