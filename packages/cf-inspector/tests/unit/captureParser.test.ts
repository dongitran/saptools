import { describe, expect, it } from "vitest";

import { looksLikeMutation, parseCaptureList } from "../../src/cli/captureParser.js";

describe("parseCaptureList", () => {
  it("returns an empty list for undefined or blank input", () => {
    expect(parseCaptureList(undefined)).toEqual([]);
    expect(parseCaptureList("   ")).toEqual([]);
  });

  it("splits top-level comma-separated expressions and trims whitespace", () => {
    expect(parseCaptureList(" user.id, payload.name ,counter ")).toEqual([
      "user.id",
      "payload.name",
      "counter",
    ]);
  });

  it("keeps nested commas inside calls, objects, arrays, and grouping", () => {
    expect(
      parseCaptureList("JSON.stringify({ id: user.id, steps: [1, 2] }), (a, b), list.map((x) => x.id)"),
    ).toEqual([
      "JSON.stringify({ id: user.id, steps: [1, 2] })",
      "(a, b)",
      "list.map((x) => x.id)",
    ]);
  });

  it("keeps commas inside quoted strings and template literals", () => {
    expect(parseCaptureList("'a,b', \"c,d\", `e,f`, value")).toEqual([
      "'a,b'",
      "\"c,d\"",
      "`e,f`",
      "value",
    ]);
  });

  it("handles escaped quote characters while scanning quoted expressions", () => {
    expect(parseCaptureList("\"a\\\",b\", next")).toEqual(["\"a\\\",b\"", "next"]);
  });

  it("drops empty pieces produced by adjacent or trailing separators", () => {
    expect(parseCaptureList("first,, second, ")).toEqual(["first", "second"]);
  });
});

describe("looksLikeMutation", () => {
  it.each([
    "user.id = 7",
    "count += 1",
    "mask &&= next",
    "index++",
    "--remaining",
    "delete payload.secret",
    "items.push(1)",
    "items.splice(0, 1)",
    "cache.set('key', value)",
    "roles.clear()",
    "Object.assign(target, source)",
    "Object.defineProperty(target, 'id', descriptor)",
  ])("detects advisory mutation syntax in %s", (expression) => {
    expect(looksLikeMutation(expression)).toBe(true);
  });

  it.each([
    "user.id",
    "x === 1",
    "x == 1",
    "x !== 1",
    "x != 1",
    "x <= 1",
    "x >= 1",
    "items.filter((entry) => entry.active)",
    "items.map((entry) => entry.id)",
    "(value) => value + 1",
    "'k=v'",
    "\"items.push(1)\"",
    "`count += 1`",
  ])("does not flag read/comparison/quoted syntax in %s", (expression) => {
    expect(looksLikeMutation(expression)).toBe(false);
  });
});
