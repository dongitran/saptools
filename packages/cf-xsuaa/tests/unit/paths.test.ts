import { sep } from "node:path";

import { describe, expect, it } from "vitest";

import { saptoolsDir, xsuaaDataPath } from "../../src/paths.js";

describe("paths", () => {
  it("saptoolsDir ends with .saptools", () => {
    expect(saptoolsDir().endsWith(`${sep}.saptools`)).toBe(true);
  });

  it("xsuaaDataPath ends with xsuaa-data.json", () => {
    expect(xsuaaDataPath().endsWith("xsuaa-data.json")).toBe(true);
  });
});
