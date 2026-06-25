export interface PreviewTruncationResult {
  readonly preview: string;
  readonly truncated: boolean;
}

export function truncatePreview(preview: string, maxChars: number): PreviewTruncationResult {
  if (maxChars <= 0) {
    return { preview, truncated: false };
  }
  if (preview.length <= maxChars) {
    return { preview, truncated: false };
  }
  return { preview: preview.slice(0, maxChars), truncated: true };
}
