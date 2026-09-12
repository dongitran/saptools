import { describe, expect, it } from "vitest";

import { listAllFieldNames, lookUpField } from "../../src/mapping.js";

/** Two backing indices of one pattern, the shape `_mapping` returns. */
function mappingOf(...indices: readonly Record<string, unknown>[]): Record<string, unknown> {
  return Object.fromEntries(indices.map((properties, position) => [`metrics-00000${String(position + 1)}`, { mappings: { properties } }]));
}

describe("lookUpField", () => {
  it("reports an implicit object rather than calling it unreadable", () => {
    // OpenSearch never writes `"type": "object"`; it is implied by a
    // `properties` block. Reading a missing type as "no answer" reported
    // `resource` — present in every index — as absent.
    const lookup = lookUpField(mappingOf({ resource: { properties: { attributes: { properties: { "sap@cf@app_name": { type: "keyword" } } } } } }), "resource");

    expect(lookup).toEqual({ status: "found", mapping: { field: "resource", type: "object" } });
  });

  it("keeps the agreed type and flags a divergent ignore_above cap", () => {
    // Directly observable only since this module was lifted out of the command
    // file: through the four rendered CLI columns, an implementation that read
    // every index's cap from the first index alone was indistinguishable from
    // a correct one.
    const lookup = lookUpField(
      mappingOf({ name: { type: "keyword", ignore_above: 256 } }, { name: { type: "keyword", ignore_above: 1024 } }),
      "name",
    );

    expect(lookup).toEqual({ status: "found", mapping: { field: "name", type: "keyword", ignoreAboveVaries: true } });
  });

  it("keeps the agreed type and flags a divergent alias target", () => {
    const lookup = lookUpField(
      mappingOf(
        { app_name: { type: "alias", path: "resource.attributes.app" }, resource: { properties: { attributes: { properties: { app: { type: "keyword" } } } } } },
        { app_name: { type: "alias", path: "resource.attributes.name" }, resource: { properties: { attributes: { properties: { name: { type: "keyword" } } } } } },
      ),
      "app_name",
    );

    expect(lookup).toEqual({
      status: "found",
      mapping: { field: "app_name", type: "keyword", aliasOf: "resource.attributes.app", aliasVaries: true },
    });
  });

  it("answers the same way whichever index the response lists first", () => {
    const container = { app_id: { properties: { inner: { type: "keyword" } } } };
    const leaf = { app_id: { type: "keyword" } };

    // A disagreement decided by JSON key order is a disagreement reported at
    // random; both orders must name both types.
    expect(lookUpField(mappingOf(container, leaf), "app_id")).toEqual({ status: "disagrees", types: ["object", "keyword"] });
    expect(lookUpField(mappingOf(leaf, container), "app_id")).toEqual({ status: "disagrees", types: ["keyword", "object"] });
  });

  it("resolves a multi-field, which is queryable but hangs off `fields` rather than `properties`", () => {
    // `metrics-*` really maps `@timestamp.keyword` and `origin.keyword`, and
    // both return real aggregation buckets — yet the lookup answered "not
    // found" for them while a sibling function handed the same names out.
    const lookup = lookUpField(mappingOf({ "@timestamp": { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } } }), "@timestamp.keyword");

    expect(lookup).toEqual({ status: "found", mapping: { field: "@timestamp.keyword", type: "keyword", ignoreAbove: 256 } });
  });

  it("stops at a multi-field instead of swallowing whatever follows it", () => {
    // The `fields` fallback returns immediately, so without the last-segment
    // guard `description.keyword.anything` would resolve to `description.keyword`
    // and report a real type for a path that names nothing. A sub-field cannot
    // carry sub-fields, so there is never a segment after one.
    const mapping = mappingOf({ description: { type: "text", fields: { keyword: { type: "keyword" } } } });

    expect(lookUpField(mapping, "description.keyword")).toEqual({
      status: "found",
      mapping: { field: "description.keyword", type: "keyword" },
    });
    expect(lookUpField(mapping, "description.keyword.keyword")).toEqual({ status: "absent" });
    expect(lookUpField(mapping, "description.keyword.anything")).toEqual({ status: "absent" });
  });

  it("does not treat an inherited property as a mapped field", () => {
    expect(lookUpField(mappingOf({ name: { type: "keyword" } }), "__proto__")).toEqual({ status: "absent" });
    expect(lookUpField(mappingOf({ name: { type: "keyword" } }), "constructor")).toEqual({ status: "absent" });
  });

  it("still reports a dangling alias as an alias, so the target is never mistaken for a usable field", () => {
    const lookup = lookUpField(mappingOf({ app_name: { type: "alias", path: "resource.attributes.gone" } }), "app_name");

    // `type: "alias"` is the whole signal that `aliasOf` could not be
    // resolved; without it the column would read as a path worth querying.
    expect(lookup).toEqual({ status: "found", mapping: { field: "app_name", type: "alias", aliasOf: "resource.attributes.gone" } });
  });
});

describe("listAllFieldNames", () => {
  it("lists nested leaves and multi-fields, not just the top level", () => {
    // Against the live pattern the top-level-only listing showed 46 names for
    // 87 leaf fields: `resource` appeared as a dead end while every
    // `resource.attributes.*` field under it — the ones worth filtering on —
    // appeared nowhere, even though `--field` resolves each one by name.
    const names = listAllFieldNames(
      mappingOf({
        resource: { properties: { attributes: { properties: { "sap@cf@app_name": { type: "keyword" }, "sap@cf@org_id": { type: "keyword" } } } } },
        origin: { type: "text", fields: { keyword: { type: "keyword" } } },
      }),
    );

    expect(names).toEqual([
      "origin",
      "origin.keyword",
      "resource",
      "resource.attributes",
      "resource.attributes.sap@cf@app_name",
      "resource.attributes.sap@cf@org_id",
    ]);
  });

  it("unions the field names across backing indices", () => {
    expect(listAllFieldNames(mappingOf({ only_here: { type: "long" } }, { and_here: { type: "long" } }))).toEqual(["and_here", "only_here"]);
  });
});

describe("fields inside a nested parent", () => {
  it("names the nested ancestor a plain filter cannot reach past", () => {
    // Measured live: a `terms` aggregation on `buckets.count`, `exemplars.spanId`
    // or `quantiles.value` returns zero buckets with zero shard failures, while
    // an ordinary sibling returns real ones. The listing shows these fields now,
    // so it has to say where they live or it advertises a dead end.
    const lookup = lookUpField(mappingOf({ exemplars: { type: "nested", properties: { spanId: { type: "keyword" } } } }), "exemplars.spanId");

    expect(lookup).toEqual({ status: "found", mapping: { field: "exemplars.spanId", type: "keyword", nestedUnder: "exemplars" } });
  });

  it("leaves the nested field's own row unmarked, since its type already says so", () => {
    const lookup = lookUpField(mappingOf({ exemplars: { type: "nested", properties: { spanId: { type: "keyword" } } } }), "exemplars");

    expect(lookup).toEqual({ status: "found", mapping: { field: "exemplars", type: "nested" } });
  });

  it("names the nearest nested ancestor, not the outermost one", () => {
    // Both levels are `nested`, so an outermost-wins implementation would
    // answer "outer" here. With only the inner one nested the two readings
    // give the same string and the test proves nothing.
    const lookup = lookUpField(
      mappingOf({ outer: { type: "nested", properties: { inner: { type: "nested", properties: { leaf: { type: "long" } } } } } }),
      "outer.inner.leaf",
    );

    expect(lookup).toEqual({ status: "found", mapping: { field: "outer.inner.leaf", type: "long", nestedUnder: "outer.inner" } });
  });

  it("takes the nesting from an alias's target, which is what a query against it compares", () => {
    const lookup = lookUpField(
      mappingOf({
        short: { type: "alias", path: "exemplars.spanId" },
        exemplars: { type: "nested", properties: { spanId: { type: "keyword" } } },
      }),
      "short",
    );

    expect(lookup).toEqual({
      status: "found",
      mapping: { field: "short", type: "keyword", aliasOf: "exemplars.spanId", nestedUnder: "exemplars" },
    });
  });

  it("carries the ancestor onto a multi-field beneath it", () => {
    const lookup = lookUpField(
      mappingOf({ events: { type: "nested", properties: { message: { type: "text", fields: { keyword: { type: "keyword" } } } } } }),
      "events.message.keyword",
    );

    expect(lookup).toEqual({ status: "found", mapping: { field: "events.message.keyword", type: "keyword", nestedUnder: "events" } });
  });

  it("flags a nesting the indices disagree about rather than picking one", () => {
    const lookup = lookUpField(
      mappingOf(
        { bag: { type: "nested", properties: { leaf: { type: "long" } } } },
        { bag: { properties: { leaf: { type: "long" } } } },
      ),
      "bag.leaf",
    );

    expect(lookup).toEqual({ status: "found", mapping: { field: "bag.leaf", type: "long", nestedUnder: "bag", nestedVaries: true } });
  });

  it("leaves an ordinary field unmarked", () => {
    expect(lookUpField(mappingOf({ value: { type: "double" } }), "value")).toEqual({
      status: "found",
      mapping: { field: "value", type: "double" },
    });
  });
});
