import { findPreferredTargetCandidates, findReferenceTargetCandidates } from "../../src/index.js";
import type { HanaLensCsn } from "../../src/index.js";
import { expect } from "../helpers/expect.js";
import { describe, it } from "../helpers/test.js";

describe("public package exports", () => {
  it("exposes target collision-resolution helpers from the package entry point", () => {
    const csn: HanaLensCsn = { definitions: {
      "acme.sales.Order": { elements: { ID: { key: true, type: "cds.UUID" } } },
      "acme.master.Order": { elements: { ID: { key: true, type: "cds.UUID" } } },
    } };

    expect(findPreferredTargetCandidates(csn, "acme.sales.Order").map((candidate) => candidate.name)).toEqual(["acme.sales.Order"]);
    expect(findReferenceTargetCandidates(csn, "Order").map((candidate) => candidate.name).sort()).toEqual(["acme.master.Order", "acme.sales.Order"]);
  });
});
