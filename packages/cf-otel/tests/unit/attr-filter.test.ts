import { describe, expect, it } from "vitest";

import { parseAttrFilter, resolveAndValidateAttrFilters } from "../../src/attr-filter.js";
import type { OpenSearchClient } from "../../src/opensearch-client.js";

describe("parseAttrFilter", () => {
  it("parses >=", () => {
    expect(parseAttrFilter("http@status_code>=400")).toEqual({
      key: "http@status_code",
      operator: ">=",
      value: "400",
    });
  });

  it("parses <=", () => {
    expect(parseAttrFilter("http@status_code<=299")).toEqual({
      key: "http@status_code",
      operator: "<=",
      value: "299",
    });
  });

  it("parses >", () => {
    expect(parseAttrFilter("http@status_code>400")).toEqual({ key: "http@status_code", operator: ">", value: "400" });
  });

  it("parses <", () => {
    expect(parseAttrFilter("http@status_code<500")).toEqual({ key: "http@status_code", operator: "<", value: "500" });
  });

  it("parses =", () => {
    expect(parseAttrFilter("http@method=POST")).toEqual({ key: "http@method", operator: "=", value: "POST" });
  });

  it("parses ~ (contains)", () => {
    expect(parseAttrFilter("http@target~BatchSearchRequest")).toEqual({
      key: "http@target",
      operator: "~",
      value: "BatchSearchRequest",
    });
  });

  it("prefers the two-character operator over a one-character prefix", () => {
    expect(parseAttrFilter("http@status_code>=400").operator).toBe(">=");
  });

  it("throws clearly on a malformed expression with no operator", () => {
    expect(() => parseAttrFilter("http@status_code400")).toThrow(/Invalid --attr expression/);
  });

  it("throws clearly on an expression with an empty key", () => {
    expect(() => parseAttrFilter(">=400")).toThrow(/Invalid --attr expression/);
  });

  it("throws clearly on an expression with an empty value", () => {
    expect(() => parseAttrFilter("http@status_code>=")).toThrow(/Invalid --attr expression/);
  });
});

describe("resolveAndValidateAttrFilters", () => {
  // Mirrors the real, nested mapping shape confirmed against a live Cloud
  // Logging instance this session: span.attributes.* and resource.attributes.*
  // are genuinely nested in the mapping tree (properties.span.properties
  // .attributes.properties[key]), never flat top-level entries — even though
  // the same key is a single flat literal string in every _source document.
  const REAL_SHAPED_MAPPING = {
    idx: {
      mappings: {
        properties: {
          span: {
            properties: {
              attributes: {
                properties: {
                  "http@status_code": { type: "keyword", ignore_above: 256 },
                  "http@response@status_code": { type: "integer" },
                  "http@method": { type: "keyword" },
                },
              },
            },
          },
          resource: {
            properties: {
              attributes: {
                properties: {
                  "sap@cf@app_name": { type: "keyword", ignore_above: 256 },
                },
              },
            },
          },
        },
      },
    },
  };

  function fakeClientWithMapping(mapping: unknown): OpenSearchClient {
    return { search: async () => ({ totalHits: 0, hits: [] }), count: async () => 0, getMapping: async () => mapping };
  }

  it("resolves a bare --attr key to its real span.attributes.* path — a bare key matches nothing in real documents", async () => {
    // Regression test for a real bug found live: --attr 'http@status_code>=400'
    // (this tool's own headline example, verbatim) silently queried a field
    // named literally "http@status_code", which does not exist in any real
    // document — every bare-key --attr filter returned zero matches,
    // unconditionally, regardless of what the data actually contained.
    const client = fakeClientWithMapping(REAL_SHAPED_MAPPING);
    const [resolved] = await resolveAndValidateAttrFilters(client, "idx", [
      { key: "http@method", operator: "=", value: "POST" },
    ]);
    expect(resolved?.key).toBe("span.attributes.http@method");
  });

  it("falls back to resource.attributes.* when the key isn't a span-level attribute", async () => {
    const client = fakeClientWithMapping(REAL_SHAPED_MAPPING);
    const [resolved] = await resolveAndValidateAttrFilters(client, "idx", [
      { key: "sap@cf@app_name", operator: "=", value: "my-app" },
    ]);
    expect(resolved?.key).toBe("resource.attributes.sap@cf@app_name");
  });

  it("leaves an already-fully-qualified key unchanged", async () => {
    const client = fakeClientWithMapping(REAL_SHAPED_MAPPING);
    const [resolved] = await resolveAndValidateAttrFilters(client, "idx", [
      { key: "span.attributes.http@method", operator: "=", value: "POST" },
    ]);
    expect(resolved?.key).toBe("span.attributes.http@method");
  });

  it("falls back to the bare key unchanged when it resolves under neither attribute bag", async () => {
    const client = fakeClientWithMapping(REAL_SHAPED_MAPPING);
    const [resolved] = await resolveAndValidateAttrFilters(client, "idx", [
      { key: "custom@thing", operator: "=", value: "x" },
    ]);
    expect(resolved?.key).toBe("custom@thing");
  });

  it("rejects a numeric comparison against a real-world keyword-mapped field, using its resolved path in the message", async () => {
    // Confirmed against a real Cloud Logging instance this session: this
    // tool's own headline --attr example field is keyword-mapped, not numeric.
    const client = fakeClientWithMapping(REAL_SHAPED_MAPPING);
    await expect(
      resolveAndValidateAttrFilters(client, "idx", [{ key: "http@status_code", operator: ">=", value: "400" }]),
    ).rejects.toThrow(/"span\.attributes\.http@status_code" is mapped as "keyword", not a numeric type/);
  });

  it("allows a numeric comparison against a genuinely numeric-mapped field, and resolves its full path", async () => {
    const client = fakeClientWithMapping(REAL_SHAPED_MAPPING);
    const [resolved] = await resolveAndValidateAttrFilters(client, "idx", [
      { key: "http@response@status_code", operator: ">=", value: "400" },
    ]);
    expect(resolved).toEqual({ key: "span.attributes.http@response@status_code", operator: ">=", value: "400" });
  });

  it("ignores non-numeric operators for the type check, but still resolves the key", async () => {
    const client = fakeClientWithMapping(REAL_SHAPED_MAPPING);
    const [resolvedEquals] = await resolveAndValidateAttrFilters(client, "idx", [
      { key: "http@method", operator: "=", value: "POST" },
    ]);
    expect(resolvedEquals?.key).toBe("span.attributes.http@method");
    const [resolvedContains] = await resolveAndValidateAttrFilters(client, "idx", [
      { key: "http@method", operator: "~", value: "POS" },
    ]);
    expect(resolvedContains?.key).toBe("span.attributes.http@method");
  });

  it("does not fail closed when the field isn't found in the mapping at all (dynamic/unmapped field)", async () => {
    const client = fakeClientWithMapping({ idx: { mappings: { properties: {} } } });
    await expect(
      resolveAndValidateAttrFilters(client, "idx", [{ key: "custom@thing", operator: ">", value: "1" }]),
    ).resolves.toEqual([{ key: "custom@thing", operator: ">", value: "1" }]);
  });
});
