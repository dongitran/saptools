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

  it("rejects invalid element property types", () => {
    expect(() => parseCsn({ definitions: { Entity: { elements: { ID: { type: 123 } } } } })).toThrow("invalid CSN definition");
    expect(() => parseCsn({ definitions: { Entity: { elements: { ID: { length: "36" } } } } })).toThrow("invalid CSN definition");
    expect(() => parseCsn({ definitions: { Entity: { elements: { ID: { key: "true" } } } } })).toThrow("invalid CSN definition");
    expect(() => parseCsn({ definitions: { Entity: { elements: { ID: { target: false } } } } })).toThrow("invalid CSN definition");
  });
});
