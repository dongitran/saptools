import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseJiraAdfDocument,
  readJiraAdfBodyInput,
  selectJiraAdfBodySource,
  textToAdfDocument,
} from "../../src/adf.js";

describe("ADF helpers", () => {
  it("converts plain text into paragraphs and hard breaks", () => {
    expect(textToAdfDocument("First line\nSecond line\n\nNext paragraph")).toEqual({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "First line" },
            { type: "hardBreak" },
            { type: "text", text: "Second line" },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Next paragraph" }],
        },
      ],
    });
  });

  it("normalizes CRLF and rejects empty plain text", () => {
    expect(textToAdfDocument("One\r\nTwo").content).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "One" },
          { type: "hardBreak" },
          { type: "text", text: "Two" },
        ],
      },
    ]);
    expect(() => textToAdfDocument(" \n\t ")).toThrow("ADF text input must not be empty.");
  });

  it("validates raw ADF documents without dropping media nodes", () => {
    const mediaDocument = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "mediaSingle",
          content: [{ type: "media", attrs: { id: "media-platform-id", type: "file" } }],
        },
      ],
    };

    expect(parseJiraAdfDocument(mediaDocument, "--adf-file")).toEqual(mediaDocument);
    for (const invalid of [
      { type: "paragraph", version: 1, content: [] },
      { type: "doc", content: [] },
      { type: "doc", version: 1, content: "not-array" },
      { type: "doc", version: 1, content: [] },
    ]) {
      expect(() => parseJiraAdfDocument(invalid, "--adf-file")).toThrow(
        "--adf-file must contain a valid ADF document",
      );
    }
  });

  it("requires exactly one body source", () => {
    expect(selectJiraAdfBodySource({ text: "hello" })).toEqual({ kind: "text", value: "hello" });
    expect(selectJiraAdfBodySource({ textFile: "body.txt" })).toEqual({
      kind: "text-file",
      value: "body.txt",
    });
    expect(selectJiraAdfBodySource({ adfFile: "body.json" })).toEqual({
      kind: "adf-file",
      value: "body.json",
    });
    expect(() => selectJiraAdfBodySource({})).toThrow("Exactly one body source");
    expect(() => selectJiraAdfBodySource({ text: "x", adfFile: "body.json" })).toThrow(
      "Exactly one body source",
    );
  });

  it("reads text and raw ADF body files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jira-adf-test-"));
    try {
      const textPath = join(dir, "body.txt");
      const adfPath = join(dir, "body.json");
      await writeFile(textPath, "From file", "utf8");
      await writeFile(
        adfPath,
        JSON.stringify({ type: "doc", version: 1, content: [{ type: "paragraph" }] }),
        "utf8",
      );

      await expect(readJiraAdfBodyInput({ textFile: textPath })).resolves.toEqual({
        inputKind: "plain-text",
        document: textToAdfDocument("From file"),
      });
      await expect(readJiraAdfBodyInput({ adfFile: adfPath })).resolves.toEqual({
        inputKind: "adf",
        document: { type: "doc", version: 1, content: [{ type: "paragraph" }] },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
