import { describe, expect, it } from "vitest";

import { getFlatAttribute, listFlatAttributeKeys, pickIdentifyingAttribute } from "../../src/attributes.js";

describe("listFlatAttributeKeys", () => {
  it("lists every top-level key sorted, treating dotted/@ keys as opaque", () => {
    const raw = {
      "span.attributes.http@target": "/foo",
      "span.attributes.http@status_code": 200,
      name: "GET",
    };
    expect(listFlatAttributeKeys(raw)).toEqual(["name", "span.attributes.http@status_code", "span.attributes.http@target"]);
  });
});

describe("getFlatAttribute", () => {
  it("reads a flat key verbatim without any dot/@ traversal", () => {
    const raw = { "span.attributes.http@target": "/foo", span: { attributes: { http: { target: "wrong" } } } };
    expect(getFlatAttribute(raw, "span.attributes.http@target")).toBe("/foo");
  });

  it("returns undefined for an absent key", () => {
    expect(getFlatAttribute({}, "missing")).toBeUndefined();
  });
});

describe("pickIdentifyingAttribute", () => {
  it("prefers http@target over lower-priority attributes", () => {
    const raw = { "span.attributes.http@target": "/x", "span.attributes.db@statement": "SELECT 1" };
    expect(pickIdentifyingAttribute(raw)).toEqual({ key: "span.attributes.http@target", value: "/x" });
  });

  it("falls back to db@statement when http@target is absent", () => {
    const raw = { "span.attributes.db@statement": "SELECT 1" };
    expect(pickIdentifyingAttribute(raw)).toEqual({ key: "span.attributes.db@statement", value: "SELECT 1" });
  });

  it("returns undefined when no known identifying attribute is present", () => {
    expect(pickIdentifyingAttribute({ name: "GET" })).toBeUndefined();
  });

  it("matches the current stable OTel semantic-convention names, not just the pre-stabilization ones", () => {
    // Regression test: real production data (confirmed live) uses url@path/
    // url@full/server@address/network@peer@address with no http@target or
    // net@peer@* present at all — the old-names-only list matched nothing.
    const raw = {
      "span.attributes.url@path": "/obs-tap/ingest",
      "span.attributes.url@full": "https://example.cfapps.hana.ondemand.com/obs-tap/ingest",
      "span.attributes.server@address": "example.cfapps.hana.ondemand.com",
      "span.attributes.network@peer@address": "10.0.0.1",
    };
    expect(pickIdentifyingAttribute(raw)).toEqual({ key: "span.attributes.url@path", value: "/obs-tap/ingest" });
  });

  it("prefers url@path (new) over http@target (old) when both happen to be present", () => {
    const raw = { "span.attributes.url@path": "/new", "span.attributes.http@target": "/old" };
    expect(pickIdentifyingAttribute(raw)).toEqual({ key: "span.attributes.url@path", value: "/new" });
  });
});
