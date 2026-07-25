import { describe, expect, it } from "vitest";

import { extractTextFromAdf } from "../../src/adf-text.js";

describe("ADF text extraction", () => {
  it("renders headings, paragraphs, lists, a rule, and hardBreak with block line breaks and markers", () => {
    const document = {
      type: "doc",
      version: 1,
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Steps to Reproduce" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Open the app" },
            { type: "hardBreak" },
            { type: "text", text: "then sign in." },
          ],
        },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Chrome" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Firefox" }] }] },
          ],
        },
        {
          type: "orderedList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Click login" }] }] },
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Enter credentials" }] }],
            },
          ],
        },
        { type: "rule" },
        { type: "paragraph", content: [{ type: "text", text: "Actual result differs." }] },
      ],
    };

    expect(extractTextFromAdf(document)).toBe(
      [
        "Steps to Reproduce",
        "",
        "Open the app\nthen sign in.",
        "",
        "- Chrome",
        "- Firefox",
        "",
        "1. Click login",
        "2. Enter credentials",
        "",
        "---",
        "",
        "Actual result differs.",
      ].join("\n"),
    );
  });

  it("renders a block-level media node between two paragraphs, preferring attrs.alt", () => {
    const document = {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Before image." }] },
        {
          type: "mediaSingle",
          content: [{ type: "media", attrs: { id: "media-1", alt: "screenshot-1.png", type: "file" } }],
        },
        { type: "paragraph", content: [{ type: "text", text: "After image." }] },
      ],
    };

    expect(extractTextFromAdf(document)).toBe("Before image.\n\n[image: screenshot-1.png]\n\nAfter image.");
  });

  it("renders a media node embedded inline within a paragraph's own content", () => {
    const document = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "See " },
            { type: "media", attrs: { id: "inline-media-id", alt: "inline-diagram.png", type: "file" } },
            { type: "text", text: " for details." },
          ],
        },
      ],
    };

    expect(extractTextFromAdf(document)).toBe("See [image: inline-diagram.png] for details.");
  });

  it("falls back to the raw attrs.id when attrs.alt is missing or blank", () => {
    const blankAlt = {
      type: "doc",
      version: 1,
      content: [{ type: "mediaSingle", content: [{ type: "media", attrs: { id: "media-42", alt: "   ", type: "file" } }] }],
    };
    const missingAlt = {
      type: "doc",
      version: 1,
      content: [{ type: "mediaSingle", content: [{ type: "media", attrs: { id: "media-43", type: "file" } }] }],
    };

    expect(extractTextFromAdf(blankAlt)).toBe("[image: media-42]");
    expect(extractTextFromAdf(missingAlt)).toBe("[image: media-43]");
  });

  it("renders nested lists indented and distinguishable from their parent list", () => {
    const document = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Parent item" }] },
                {
                  type: "bulletList",
                  content: [
                    { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Child item" }] }] },
                  ],
                },
              ],
            },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Second parent item" }] }] },
          ],
        },
      ],
    };

    expect(extractTextFromAdf(document)).toBe("- Parent item\n  - Child item\n- Second parent item");
  });

  it("respects a custom ordered list start value and numbers nested lists independently", () => {
    const document = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "orderedList",
          attrs: { order: 5 },
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Fifth step" }] },
                {
                  type: "orderedList",
                  content: [
                    { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Sub step one" }] }] },
                    { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Sub step two" }] }] },
                  ],
                },
              ],
            },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Sixth step" }] }] },
          ],
        },
      ],
    };

    expect(extractTextFromAdf(document)).toBe(
      "5. Fifth step\n  1. Sub step one\n  2. Sub step two\n6. Sixth step",
    );
  });

  it("keeps plain multi-paragraph text readable with real line breaks instead of collapsed spaces", () => {
    const document = {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First paragraph." }] },
        { type: "paragraph", content: [{ type: "text", text: "Second   paragraph." }] },
      ],
    };

    expect(extractTextFromAdf(document)).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("recurses into an unknown node type's content instead of throwing or losing text", () => {
    const document = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "expand",
          attrs: { title: "Details" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Hidden detail text." }] }],
        },
      ],
    };

    expect(() => extractTextFromAdf(document)).not.toThrow();
    expect(extractTextFromAdf(document)).toBe("Hidden detail text.");
  });

  it("renders a bare block-level media node without a mediaSingle wrapper", () => {
    const document = {
      type: "doc",
      version: 1,
      content: [{ type: "media", attrs: { id: "bare-media-id", alt: "bare.png", type: "file" } }],
    };

    expect(extractTextFromAdf(document)).toBe("[image: bare.png]");
  });

  it("skips a heading with no content array instead of producing a stray blank line", () => {
    const document = {
      type: "doc",
      version: 1,
      content: [
        { type: "heading", attrs: { level: 1 } },
        { type: "paragraph", content: [{ type: "text", text: "Still here." }] },
      ],
    };

    expect(extractTextFromAdf(document)).toBe("Still here.");
  });

  it("falls back to a node's own text when content is missing or not an array", () => {
    const document = {
      type: "doc",
      version: 1,
      content: "not-an-array",
      text: "Readable fallback",
    };

    expect(extractTextFromAdf(document)).toBe("Readable fallback");
  });

  it("falls back to a generic label when a mediaSingle wraps no media child", () => {
    const document = {
      type: "doc",
      version: 1,
      content: [{ type: "mediaSingle", content: [] }],
    };

    expect(extractTextFromAdf(document)).toBe("[image: attachment]");
  });

  it("ignores a non-record child mixed into inline content instead of throwing", () => {
    const document = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Before " }, null, "stray-string", { type: "text", text: "after." }],
        },
      ],
    };

    expect(extractTextFromAdf(document)).toBe("Before after.");
  });

  it("stays a single-argument function that degrades gracefully on non-ADF input", () => {
    expect(extractTextFromAdf(null)).toBe("");
    expect(extractTextFromAdf(undefined)).toBe("");
    expect(extractTextFromAdf({})).toBe("");
    expect(extractTextFromAdf("not-an-object")).toBe("");
    expect(extractTextFromAdf.length).toBe(1);
  });
});
