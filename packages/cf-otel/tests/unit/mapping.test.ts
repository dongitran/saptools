import { describe, expect, it } from "vitest";

import { findFieldInMapping, getFieldMapping, resolveAggregatableField } from "../../src/mapping.js";
import type { OpenSearchClient } from "../../src/opensearch-client.js";

const SAMPLE_MAPPING = {
  "otel-v1-apm-span-000001": {
    mappings: {
      properties: {
        name: { type: "keyword", ignore_above: 1024 },
        serviceName: { type: "keyword", ignore_above: 256 },
        description: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } },
        rawMessage: { type: "text" },
      },
    },
  },
};

function fakeClientWithMapping(mapping: unknown): OpenSearchClient {
  return {
    search: async () => ({ totalHits: 0, hits: [] }),
    count: async () => 0,
    getMapping: async () => mapping,
  };
}

describe("findFieldInMapping", () => {
  it("finds a keyword field's type and ignore_above", () => {
    expect(findFieldInMapping(SAMPLE_MAPPING, "name")).toEqual({ field: "name", type: "keyword", ignoreAbove: 1024 });
  });

  it("returns undefined for a field that does not exist", () => {
    expect(findFieldInMapping(SAMPLE_MAPPING, "nope")).toBeUndefined();
  });

  // Confirmed against a real Cloud Logging instance's actual _mapping response
  // this session: a flat `_source` key like "span.attributes.url@path" is a
  // single literal field in every document, but the MAPPING TREE itself
  // genuinely nests on the `.` segments — properties.span.properties
  // .attributes.properties["url@path"] — even though `@` within the last
  // segment never nests further. A naive single-level `properties[field]`
  // lookup found nothing for this entire family of fields.
  const NESTED_ATTRIBUTE_MAPPING = {
    "otel-v1-apm-span-000001": {
      mappings: {
        properties: {
          name: { type: "keyword", ignore_above: 1024 },
          span: {
            properties: {
              attributes: {
                properties: {
                  "url@path": { type: "keyword", ignore_above: 256 },
                  "http@response@status_code": { type: "integer", ignore_malformed: true },
                },
              },
            },
          },
          resource: {
            properties: {
              attributes: {
                properties: {
                  "sap@cf@org_name": { type: "keyword", ignore_above: 256 },
                },
              },
            },
          },
        },
      },
    },
  };

  it("resolves a dotted, nested flat attribute key by walking each segment's own nested properties", () => {
    expect(findFieldInMapping(NESTED_ATTRIBUTE_MAPPING, "span.attributes.url@path")).toEqual({
      field: "span.attributes.url@path",
      type: "keyword",
      ignoreAbove: 256,
    });
    expect(findFieldInMapping(NESTED_ATTRIBUTE_MAPPING, "resource.attributes.sap@cf@org_name")).toEqual({
      field: "resource.attributes.sap@cf@org_name",
      type: "keyword",
      ignoreAbove: 256,
    });
  });

  it("resolves a nested numeric attribute field without an ignore_above", () => {
    expect(findFieldInMapping(NESTED_ATTRIBUTE_MAPPING, "span.attributes.http@response@status_code")).toEqual({
      field: "span.attributes.http@response@status_code",
      type: "integer",
    });
  });

  it("still resolves a plain, undotted field name in one step (unchanged from before)", () => {
    expect(findFieldInMapping(NESTED_ATTRIBUTE_MAPPING, "name")).toEqual({ field: "name", type: "keyword", ignoreAbove: 1024 });
  });

  it("returns undefined for a dotted path that doesn't exist at some segment", () => {
    expect(findFieldInMapping(NESTED_ATTRIBUTE_MAPPING, "span.attributes.nope")).toBeUndefined();
    expect(findFieldInMapping(NESTED_ATTRIBUTE_MAPPING, "nope.attributes.url@path")).toBeUndefined();
  });
});

describe("getFieldMapping", () => {
  it("looks the field up through the client", async () => {
    const client = fakeClientWithMapping(SAMPLE_MAPPING);
    expect(await getFieldMapping(client, "otel-v1-apm-span-*", "serviceName")).toEqual({
      field: "serviceName",
      type: "keyword",
      ignoreAbove: 256,
    });
  });
});

describe("resolveAggregatableField", () => {
  it("returns the bare field name as-is when it is already keyword-mapped", async () => {
    const client = fakeClientWithMapping(SAMPLE_MAPPING);
    expect(await resolveAggregatableField(client, "idx", "name")).toBe("name");
  });

  it("falls back to the .keyword multi-field when the bare field is text-mapped and has one", async () => {
    const client = fakeClientWithMapping(SAMPLE_MAPPING);
    expect(await resolveAggregatableField(client, "idx", "description")).toBe("description.keyword");
  });

  it("throws a clear error when a text field has no .keyword multi-field to fall back to", async () => {
    const client = fakeClientWithMapping(SAMPLE_MAPPING);
    await expect(resolveAggregatableField(client, "idx", "rawMessage")).rejects.toThrow(/no \.keyword sub-field/);
  });

  it("throws when the field does not exist in the mapping at all", async () => {
    const client = fakeClientWithMapping(SAMPLE_MAPPING);
    await expect(resolveAggregatableField(client, "idx", "missing")).rejects.toThrow(/was not found in the mapping/);
  });

  /**
   * A field alias registers only its own full name; the target's multi-fields
   * are not reachable through it. So `<alias>.keyword` is unmapped — and a
   * `terms` aggregation on an unmapped field returns empty buckets with no
   * error, which is exactly the silent failure this function exists to
   * prevent. The sub-field has to be named on the target.
   */
  it("builds the .keyword sub-field on an alias's target, not on the alias name", async () => {
    const client = fakeClientWithMapping({
      idx: {
        mappings: {
          properties: {
            app_name: { type: "alias", path: "resource.attributes.sap@cf@app_name" },
            resource: {
              properties: {
                attributes: {
                  properties: {
                    "sap@cf@app_name": { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(await resolveAggregatableField(client, "idx", "app_name")).toBe(
      "resource.attributes.sap@cf@app_name.keyword",
    );
  });

  it("returns an alias's target for a keyword-mapped target, which OpenSearch resolves either way", async () => {
    const client = fakeClientWithMapping({
      idx: {
        mappings: {
          properties: {
            app_name: { type: "alias", path: "resource.attributes.sap@cf@app_name" },
            resource: { properties: { attributes: { properties: { "sap@cf@app_name": { type: "keyword" } } } } },
          },
        },
      },
    });

    expect(await resolveAggregatableField(client, "idx", "app_name")).toBe("resource.attributes.sap@cf@app_name");
  });

  it("names the alias and its target when the target is text with no .keyword to fall back to", async () => {
    const client = fakeClientWithMapping({
      idx: {
        mappings: {
          properties: {
            body: { type: "alias", path: "rawMessage" },
            rawMessage: { type: "text" },
          },
        },
      },
    });

    await expect(resolveAggregatableField(client, "idx", "body")).rejects.toThrow(
      /is an alias onto "rawMessage", which is text-mapped/,
    );
  });
});

describe("mapping disagreement across backing indices", () => {
  const straddling = {
    "otel-v1-apm-span-000001": {
      mappings: { properties: { span: { properties: { attributes: { properties: { "http@x": { type: "keyword" } } } } } } },
    },
    "otel-v1-apm-span-000014": {
      mappings: { properties: { span: { properties: { attributes: { properties: { "http@x": { type: "long" } } } } } } },
    },
  };

  it("reports no type when the backing indices disagree", () => {
    // The query runs against the whole pattern, so a type sampled from one
    // index is not a fact about the others. Reporting the first index's
    // opinion let `=` send an array-rendered term that a long-mapped shard
    // rejects, turning a query that worked into a shard exception.
    expect(findFieldInMapping(straddling, "span.attributes.http@x")).toBeUndefined();
  });

  it("still reports the type when every index that has the field agrees", () => {
    const agreeing = {
      a: { mappings: { properties: { span: { properties: { attributes: { properties: { "http@x": { type: "keyword" } } } } } } } },
      b: { mappings: { properties: { span: { properties: { attributes: { properties: { "http@x": { type: "keyword" } } } } } } } },
    };

    expect(findFieldInMapping(agreeing, "span.attributes.http@x")).toMatchObject({ type: "keyword" });
  });

  it("ignores indices that simply do not have the field", () => {
    const partial = {
      a: { mappings: { properties: {} } },
      b: { mappings: { properties: { span: { properties: { attributes: { properties: { "http@x": { type: "keyword" } } } } } } } },
    };

    expect(findFieldInMapping(partial, "span.attributes.http@x")).toMatchObject({ type: "keyword" });
  });
});

/**
 * `otel-v1-apm-span-*` carries 135 field aliases (measured live, 9 per backing
 * index) — short names pointing at the canonical `resource.attributes.*`
 * paths — and OpenSearch resolves an alias in queries and aggregations alike
 * (measured: an aggregation on `app_name` and on its target return identical
 * buckets), so `--attr <alias>=v` is a thing a user can reasonably write.
 *
 * Reporting the pointer's own type (`"alias"`) rather than the target's got
 * two things wrong. The one that always bites: `"alias"` is not a numeric
 * type, so `>=`/`<=` against an alias onto a numeric field was rejected
 * outright as "mapped as alias, not a numeric type" for a comparison that is
 * perfectly valid. The second is conditional and was NOT reproducible on the
 * tenant measured here — `"alias"` is not in `TEXTUAL_MAPPING_TYPES` either,
 * so `=` fell back to a plain `term` rather than the array-rendered
 * disjunction, but both encodings returned identical counts against this
 * tenant's data, for the alias and for an array-shaped span attribute alike.
 * The disjunction exists for attributes that *are* stored array-rendered; an
 * alias onto one would still need the resolved type to reach it.
 */
describe("field aliases", () => {
  const aliased = (targetType: string, path = "resource.attributes.sap@cf@app_id"): Record<string, unknown> => ({
    "otel-v1-apm-span-000001": {
      mappings: {
        properties: {
          app_id: { type: "alias", path },
          resource: { properties: { attributes: { properties: { "sap@cf@app_id": { type: targetType, ignore_above: 256 } } } } },
        },
      },
    },
  });

  it("reports the target's type, so an equality filter uses the encoding that field really needs", () => {
    expect(findFieldInMapping(aliased("keyword"), "app_id")).toMatchObject({
      type: "keyword",
      ignoreAbove: 256,
      aliasOf: "resource.attributes.sap@cf@app_id",
    });
  });

  it("reports a numeric target as numeric, so a comparison is no longer rejected as non-numeric", () => {
    expect(findFieldInMapping(aliased("integer"), "app_id")).toMatchObject({ type: "integer" });
  });

  it("leaves the concrete field untouched", () => {
    const mapping = findFieldInMapping(aliased("keyword"), "resource.attributes.sap@cf@app_id");
    expect(mapping).toMatchObject({ type: "keyword" });
    expect(mapping).not.toHaveProperty("aliasOf");
  });

  it("keeps reporting an alias whose target is missing, naming the target rather than inventing a type", () => {
    const dangling = {
      a: { mappings: { properties: { app_id: { type: "alias", path: "resource.attributes.gone" } } } },
    };

    expect(findFieldInMapping(dangling, "app_id")).toMatchObject({ type: "alias", aliasOf: "resource.attributes.gone" });
  });

  it("does not follow an alias chain, which OpenSearch forbids and a self-reference would spin on", () => {
    const chained = {
      a: { mappings: { properties: { one: { type: "alias", path: "two" }, two: { type: "alias", path: "one" } } } },
    };

    expect(findFieldInMapping(chained, "one")).toMatchObject({ type: "alias", aliasOf: "two" });
  });

  it("tolerates an alias with no usable path at all", () => {
    const malformed = { a: { mappings: { properties: { app_id: { type: "alias" } } } } };

    expect(findFieldInMapping(malformed, "app_id")).toMatchObject({ type: "alias" });
  });

  /**
   * Divergence is reported *alongside* the type, never instead of it.
   * `undefined` from this function does not mean "be careful" — three callers
   * read it as "the field is absent", and each then does something worse than
   * reporting a type with a caveat: the `--attr` numeric guard is skipped
   * entirely (so `>=` on a keyword becomes a silently lexicographic `range`),
   * `assertFieldExists` blames the tenant's collector config, and
   * `mapping --field` calls a field present in every index missing.
   */
  it("still reports the agreed type when two indices point the same alias at different targets", () => {
    const divergent = {
      ...aliased("keyword", "resource.attributes.sap@cf@app_id"),
      "otel-v1-apm-span-000002": {
        mappings: {
          properties: {
            app_id: { type: "alias", path: "resource.attributes.other" },
            resource: { properties: { attributes: { properties: { other: { type: "keyword", ignore_above: 256 } } } } },
          },
        },
      },
    };

    expect(findFieldInMapping(divergent, "app_id")).toMatchObject({ type: "keyword", aliasVaries: true });
  });

  it("answers for an alias-and-concrete straddle, which no query can tell apart anyway", () => {
    const straddle = {
      a: { mappings: { properties: { app_id: { type: "keyword" } } } },
      b: {
        mappings: {
          properties: {
            app_id: { type: "alias", path: "resource.attributes.sap@cf@app_id" },
            resource: { properties: { attributes: { properties: { "sap@cf@app_id": { type: "keyword" } } } } },
          },
        },
      },
    };

    // OpenSearch resolves the alias per index at query time and both sides are
    // keyword, so every encoding decision downstream is identical. Withholding
    // the type here would buy nothing and cost the guards above.
    expect(findFieldInMapping(straddle, "app_id")).toMatchObject({ type: "keyword", aliasVaries: true });
  });
});

describe("ignore_above across backing indices", () => {
  const withCaps = (left: number | undefined, right: number | undefined): Record<string, unknown> => ({
    a: { mappings: { properties: { unit: { type: "keyword", ...(left === undefined ? {} : { ignore_above: left }) } } } },
    b: { mappings: { properties: { unit: { type: "keyword", ...(right === undefined ? {} : { ignore_above: right }) } } } },
  });

  it("reports the cap when every index agrees", () => {
    expect(findFieldInMapping(withCaps(256, 256), "unit")).toMatchObject({ type: "keyword", ignoreAbove: 256 });
  });

  /**
   * A `keyword` past its `ignore_above` is stored but never indexed, so a
   * divergent cap means the same term query matches on one shard and not on
   * another. Reporting whichever index answered first stated one shard's fact
   * as the pattern's. The type still answers — withholding it over an advisory
   * column would suppress what the caller came for.
   */
  it("flags a divergent cap rather than reporting whichever index answered first", () => {
    // Not simply omitted: a blank cap reads as "no cap at all", which is the
    // safe interpretation, while divergence is the hazardous one.
    expect(findFieldInMapping(withCaps(256, 32_766), "unit")).toEqual({
      field: "unit",
      type: "keyword",
      ignoreAboveVaries: true,
    });
    expect(findFieldInMapping(withCaps(32_766, 256), "unit")).toEqual({
      field: "unit",
      type: "keyword",
      ignoreAboveVaries: true,
    });
  });

  it("treats an absent cap as its own value, not as a match for any number", () => {
    expect(findFieldInMapping(withCaps(256, undefined), "unit")).toEqual({
      field: "unit",
      type: "keyword",
      ignoreAboveVaries: true,
    });
  });

  it("reports no cap, and no divergence, when no index sets one", () => {
    expect(findFieldInMapping(withCaps(undefined, undefined), "unit")).toEqual({ field: "unit", type: "keyword" });
  });
});
