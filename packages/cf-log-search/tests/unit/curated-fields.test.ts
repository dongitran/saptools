import { describe, expect, it } from "vitest";

import { CURATED_FIELDS } from "../../src/curated-fields.js";

describe("CURATED_FIELDS", () => {
  it("includes @timestamp marked as the only safe time field", () => {
    const entry = CURATED_FIELDS.find((field) => field.field === "@timestamp");
    expect(entry).toBeDefined();
    expect(entry?.notes).toMatch(/only safe time field/);
  });

  it("flags trace_id's dual meaning explicitly", () => {
    const entry = CURATED_FIELDS.find((field) => field.field === "trace_id");
    expect(entry?.notes).toMatch(/RTR/);
    expect(entry?.notes).toMatch(/resolveTraceId/);
  });

  it("has no duplicate field names", () => {
    const names = CURATED_FIELDS.map((field) => field.field);
    expect(new Set(names).size).toBe(names.length);
  });
});
