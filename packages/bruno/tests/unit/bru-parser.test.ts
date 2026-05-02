import { describe, expect, it } from "vitest";

import {
  listBlocks,
  parseBruEnvFile,
  parseKeyValueBody,
  parseListBody,
} from "../../src/bru-parser.js";

describe("listBlocks", () => {
  it("finds curly-brace blocks", () => {
    const raw = "vars {\n  a: 1\n  b: 2\n}\n";
    const blocks = listBlocks(raw);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.header).toBe("vars");
    expect(blocks[0]?.open).toBe("{");
  });

  it("finds indented headers", () => {
    const raw = "  vars {\n    a: 1\n  }\n";
    const blocks = listBlocks(raw);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.header).toBe("vars");
  });

  it("finds bracket list blocks", () => {
    const raw = "vars:secret [\n  accessToken\n  other\n]\n";
    const blocks = listBlocks(raw);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.header).toBe("vars:secret");
    expect(blocks[0]?.open).toBe("[");
  });

  it("handles multiple blocks", () => {
    const raw = "meta {\n  name: Test\n}\n\nvars {\n  x: 1\n}\n";
    const blocks = listBlocks(raw);
    expect(blocks.map((b) => b.header)).toEqual(["meta", "vars"]);
  });

  it("handles nested braces", () => {
    const raw = "script:pre-request {\n  if (x) {\n    y = 1;\n  }\n}\n";
    const blocks = listBlocks(raw);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.header).toBe("script:pre-request");
  });

  it("skips unterminated blocks", () => {
    const raw = "vars {\n  a: 1\n";
    const blocks = listBlocks(raw);
    expect(blocks).toHaveLength(0);
  });

  it("continues after an unterminated earlier block", () => {
    const raw = "vars {\n  a: 1\n\nmeta {\n  name: Alpha\n}\n";
    const blocks = listBlocks(raw);
    expect(blocks.map((block) => block.header)).toEqual(["meta"]);
  });
});

describe("parseKeyValueBody", () => {
  it("parses key-value pairs", () => {
    const entries = parseKeyValueBody("  a: 1\n  b: hello world\n");
    expect(Object.fromEntries(entries)).toEqual({ a: "1", b: "hello world" });
  });

  it("skips empty lines and comments", () => {
    const entries = parseKeyValueBody("  a: 1\n  // comment\n\n  b: 2\n");
    expect(Object.fromEntries(entries)).toEqual({ a: "1", b: "2" });
  });

  it("allows colon in values", () => {
    const entries = parseKeyValueBody("  url: https://example.com:443/x\n");
    expect(entries.get("url")).toBe("https://example.com:443/x");
  });

  it("uses the last value when duplicate keys appear", () => {
    const entries = parseKeyValueBody("  a: old\n  a: new\n");
    expect(entries.get("a")).toBe("new");
  });
});

describe("parseListBody", () => {
  it("parses list items", () => {
    const items = parseListBody("  a\n  b\n  c\n");
    expect(items).toEqual(["a", "b", "c"]);
  });

  it("skips comments", () => {
    const items = parseListBody("  a\n  // skip\n  b\n");
    expect(items).toEqual(["a", "b"]);
  });
});

describe("parseBruEnvFile", () => {
  it("parses a full env file", () => {
    const raw = [
      "vars {",
      "  baseUrl: https://api.example.com",
      "  __cf_region: ap10",
      "}",
      "",
      "vars:secret [",
      "  accessToken",
      "]",
      "",
    ].join("\n");
    const parsed = parseBruEnvFile(raw);
    expect(parsed.vars.entries.get("baseUrl")).toBe("https://api.example.com");
    expect(parsed.vars.entries.get("__cf_region")).toBe("ap10");
    expect(parsed.secrets).toEqual(["accessToken"]);
  });

  it("returns empty structures when blocks missing", () => {
    const parsed = parseBruEnvFile("");
    expect(parsed.vars.entries.size).toBe(0);
    expect(parsed.secrets).toEqual([]);
  });
});
