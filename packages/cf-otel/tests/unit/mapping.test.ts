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
});
