import { describe, expect, it } from "vitest";

import { previewCell } from "../../src/result-preview.js";

describe("result cell preview", () => {
  it("keeps values at the limit unchanged", () => {
    const preview = previewCell("a".repeat(128), 128);

    expect(preview).toEqual({
      text: "a".repeat(128),
      truncated: false,
      originalLength: 128,
      unit: "chars",
    });
  });

  it("returns only the first 128 characters from a large text cell", () => {
    const preview = previewCell("x".repeat(1_000_000), 128);

    expect(preview.text).toBe("x".repeat(128));
    expect(preview.truncated).toBe(true);
    expect(preview.originalLength).toBe(1_000_000);
  });

  it("does not split Unicode code points", () => {
    const preview = previewCell("A😀BC", 2);

    expect(preview.text).toBe("A😀");
    expect(preview.originalLength).toBe(4);
  });

  it("normalizes control whitespace after selecting the prefix", () => {
    const preview = previewCell("line one\nline two\tend", 18);

    expect(preview.text).toBe("line one line two ");
    expect(preview.truncated).toBe(true);
  });

  it("converts only the Buffer bytes that fit the visible limit", () => {
    const preview = previewCell(Buffer.alloc(1_000_000, 0xab), 10);

    expect(preview).toEqual({
      text: "0xabababab",
      truncated: true,
      originalLength: 1_000_000,
      unit: "bytes",
    });
  });
});
