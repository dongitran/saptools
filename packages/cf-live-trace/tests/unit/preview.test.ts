import { describe, expect, it } from "vitest";

import { truncatePreview } from "../../src/preview.js";

describe("preview truncation", () => {
  it("keeps unlimited and short previews intact", () => {
    expect(truncatePreview("abcdef", 0)).toEqual({ preview: "abcdef", truncated: false });
    expect(truncatePreview("abc", 3)).toEqual({ preview: "abc", truncated: false });
  });

  it("marks long previews as truncated", () => {
    expect(truncatePreview("abcdef", 3)).toEqual({ preview: "abc", truncated: true });
  });
});
