import { Buffer } from "node:buffer";

export interface PreviewTruncationResult {
  readonly preview: string;
  readonly truncated: boolean;
}

export function truncatePreview(preview: string, maxBytes: number): PreviewTruncationResult {
  if (maxBytes <= 0) {
    return { preview, truncated: false };
  }
  const encoded = Buffer.from(preview);
  if (encoded.length <= maxBytes) {
    return { preview, truncated: false };
  }
  return {
    preview: encoded.subarray(0, utf8Boundary(encoded, maxBytes)).toString("utf8"),
    truncated: true,
  };
}

function utf8Boundary(encoded: Buffer, maxBytes: number): number {
  let boundary = Math.min(maxBytes, encoded.length);
  while (boundary > 0 && isContinuationByte(encoded[boundary])) {
    boundary -= 1;
  }
  return boundary;
}

function isContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80;
}
