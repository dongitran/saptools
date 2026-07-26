import { levenshtein } from "../../src/levenshtein.js";
import { expect } from "../helpers/expect.js";
import { describe, it } from "../helpers/test.js";

describe("levenshtein", () => {
  it("computes edit distance deterministically", () => {
    expect(levenshtein("BusinesReq".toLowerCase(), "BusinessRequest".toLowerCase())).toBeLessThan(6);
    expect(levenshtein("same", "same")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
  });

  it("separates --kind typos from every other real CLI flag with margin", () => {
    const kindFlag = "--kind";
    const typos = ["--Kind", "--KIND", "--kInd", "--knid"];
    const realFlags = ["--dir", "--prefix", "--allow-fallback", "--strict", "--expand", "--with-annotations", "--regex", "--help"];

    for (const typo of typos) {
      expect(levenshtein(typo.toLowerCase(), kindFlag) <= 2).toBe(true);
    }
    for (const flag of realFlags) {
      expect(levenshtein(flag.toLowerCase(), kindFlag) > 2).toBe(true);
    }
  });
});