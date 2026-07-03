import { levenshtein } from "../../src/levenshtein.js";
import { expect } from "../helpers/expect.js";
import { describe, it } from "../helpers/test.js";

describe("levenshtein", () => {
  it("computes edit distance deterministically", () => {
    expect(levenshtein("BusinesReq".toLowerCase(), "BusinessRequest".toLowerCase())).toBeLessThan(6);
    expect(levenshtein("same", "same")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
  });
});