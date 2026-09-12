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
    expect(resolved).toEqual({
      key: "span.attributes.http@response@status_code",
      operator: ">=",
      value: "400",
      mappedType: "integer",
    });
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
  it("carries the resolved mapping type so = can gate its array-rendered encoding", async () => {
    const client = fakeClientWithMapping(REAL_SHAPED_MAPPING);

    const [keyword] = await resolveAndValidateAttrFilters(client, "idx", [
      { key: "http@status_code", operator: "=", value: "200" },
    ]);
    const [unmapped] = await resolveAndValidateAttrFilters(client, "idx", [
      { key: "custom@thing", operator: "=", value: "x" },
    ]);

    expect(keyword?.mappedType).toBe("keyword");
    // No mapping means no claim about the type, so `=` must stay conservative.
    expect(unmapped?.mappedType).toBeUndefined();
  });
});

describe("a key whose backing indices disagree about its type", () => {
  function clientWithDisagreement(): OpenSearchClient {
    const bag = (definition: Record<string, unknown>): Record<string, unknown> => ({
      mappings: { properties: { span: { properties: { attributes: { properties: { "http@status_code": definition } } } } } },
    });
    return {
      search: async () => ({ totalHits: 0, hits: [] }),
      count: async () => 0,
      getMapping: async () => ({ "otel-v1-apm-span-000001": bag({ type: "keyword" }), "otel-v1-apm-span-000002": bag({ type: "integer" }) }),
    } as unknown as OpenSearchClient;
  }

  it("still resolves the key to its attribute bag instead of falling through to a bare name", async () => {
    // The prefix probe used to ask for a resolved *type*, so a disagreement
    // read as "not in this bag" and the loop fell through to the bare key,
    // which is never a real document field: the filter matched nothing at
    // exit 0 while the notice told the caller to check a spelling that was
    // already correct.
    const notices: string[] = [];
    const resolved = await resolveAndValidateAttrFilters(
      clientWithDisagreement(),
      "otel-v1-apm-span-*",
      [{ key: "http@status_code", operator: "=", value: "404" }],
      (message) => notices.push(message),
    );

    expect(resolved[0]?.key).toBe("span.attributes.http@status_code");
    expect(notices.join(" ")).toMatch(/mapped inconsistently/);
    expect(notices.join(" ")).not.toMatch(/matches no field/);
  });

  it("refuses a numeric comparison rather than sending a range it cannot type", async () => {
    await expect(
      resolveAndValidateAttrFilters(clientWithDisagreement(), "otel-v1-apm-span-*", [
        { key: "http@status_code", operator: ">=", value: "400" },
      ]),
    ).rejects.toThrow(/mapped inconsistently across the backing indices/);
  });
});

describe("a key inside a nested parent", () => {
  it("says the filter cannot reach it, instead of resolving cleanly and matching nothing", async () => {
    const client = {
      search: async () => ({ totalHits: 0, hits: [] }),
      count: async () => 0,
      getMapping: async () => ({
        "otel-v1-apm-span-000001": {
          mappings: { properties: { events: { type: "nested", properties: { attributes: { properties: { "exception@type": { type: "keyword" } } } } } } },
        },
      }),
    } as unknown as OpenSearchClient;

    // The key resolves — the mapping really has it — so nothing else in the
    // pipeline would have complained. A `nested` parent stores its children as
    // separate hidden documents, and no command here builds a `nested` query.
    const notices: string[] = [];
    const resolved = await resolveAndValidateAttrFilters(
      client,
      "otel-v1-apm-span-*",
      [{ key: "events.attributes.exception@type", operator: "=", value: "TimeoutError" }],
      (message) => notices.push(message),
    );

    expect(resolved[0]?.key).toBe("events.attributes.exception@type");
    expect(notices.join(" ")).toMatch(/inside the nested "events" documents/);
    expect(notices.join(" ")).not.toMatch(/matches no field/);
  });
});

describe("a key that names a place in the document rather than a value", () => {
  function clientWith(properties: Record<string, unknown>): OpenSearchClient {
    return {
      search: async () => ({ totalHits: 0, hits: [] }),
      count: async () => 0,
      getMapping: async () => ({ "otel-v1-apm-span-000001": { mappings: { properties } } }),
    } as unknown as OpenSearchClient;
  }

  it.each([
    ["resource", { resource: { properties: { attributes: { properties: { app: { type: "keyword" } } } } } }, "object"],
    ["events", { events: { type: "nested", properties: { name: { type: "keyword" } } } }, "nested"],
  ])("warns that %s is a %s container a filter cannot match", async (key, properties, kind) => {
    // Measured live: both a `term` filter and a `terms` aggregation on a
    // container return nothing with zero shard failures. Until the lookup
    // learned to report implicit objects, these fell into the "matches no
    // field" notice — wrong about the reason, right about the consequence — so
    // reporting the type without this check removed the only warning there was.
    const notices: string[] = [];
    const resolved = await resolveAndValidateAttrFilters(
      clientWith(properties as Record<string, unknown>),
      "otel-v1-apm-span-*",
      [{ key, operator: "=", value: "x" }],
      (message) => notices.push(message),
    );

    expect(resolved[0]?.key).toBe(key);
    expect(notices.join(" ")).toContain(`names ${kind === "object" ? "an" : "a"} ${kind} container`);
  });
});
