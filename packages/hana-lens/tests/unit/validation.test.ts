import { parseCsn } from "../../src/validation.js";
import { expect } from "../helpers/expect.js";
import { describe, it } from "../helpers/test.js";

describe("parseCsn", () => {
  it("accepts typed CSN definitions with valid elements", () => {
    expect(parseCsn({ definitions: { Entity: { elements: { ID: { key: true, type: "cds.String" } } } } })).toEqual({
      definitions: { Entity: { elements: { ID: { key: true, type: "cds.String" } } } },
    });
  });

  it("rejects missing definitions, non-object elements, and non-object element values", () => {
    expect(() => parseCsn({})).toThrow("definitions object");
    expect(() => parseCsn({ definitions: { Entity: { elements: [] } } })).toThrow("invalid CSN definition");
    expect(() => parseCsn({ definitions: { Entity: { elements: { ID: "bad" } } } })).toThrow("invalid CSN definition");
  });
});