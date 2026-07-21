import { describe, expect, it, vi } from "vitest";

import { captureRemoteGraph, captureRemoteValues } from "../../src/remote-object.js";
import type { RemoteObjectClient, RemotePropertyDescriptor } from "../../src/remote-object.js";

describe("remote object graph capture", () => {
  it("preserves aliases, cycles, special values, and accessor descriptors without invoking getters", async () => {
    const getProperties = vi.fn(async (objectId: string) => objectId === "root" ? [
      { name: "self", value: { type: "object", objectId: "root", description: "Object" } },
      { name: "missing", value: { type: "undefined" } },
      { name: "large", value: { type: "bigint", unserializableValue: "42n" } },
      { name: "secretGetter", get: { type: "function", objectId: "getter" } },
    ] : []);
    const releaseObject = vi.fn(async (): Promise<void> => undefined);
    const client: RemoteObjectClient = { getProperties, releaseObject };

    const result = await captureRemoteGraph(client, { type: "object", objectId: "root", description: "Object" }, {
      maxDepth: 4,
      maxProperties: 10,
      maxNodes: 10,
      maxBytes: 10_000,
    });

    expect(result.root).toEqual({ kind: "ref", nodeId: "root" });
    expect(result.nodes["root"]?.properties).toMatchObject({
      self: { kind: "ref", nodeId: "root" },
      missing: { kind: "undefined" },
      large: { kind: "bigint", value: "42" },
      secretGetter: { kind: "accessor", hasGetter: true, hasSetter: false },
    });
    expect(getProperties).toHaveBeenCalledTimes(1);
    expect(releaseObject).toHaveBeenCalledWith("root");
    expect(releaseObject).not.toHaveBeenCalledWith("getter");
  });

  it("marks bounded objects as truncated", async () => {
    const client: RemoteObjectClient = {
      getProperties: async (): Promise<readonly [{ readonly name: "child"; readonly value: { readonly type: "object"; readonly objectId: "child" } }]> => [{ name: "child", value: { type: "object", objectId: "child" } }],
      releaseObject: async (): Promise<void> => undefined,
    };
    const result = await captureRemoteGraph(client, { type: "object", objectId: "root" }, {
      maxDepth: 0,
      maxProperties: 1,
      maxNodes: 1,
      maxBytes: 1000,
    });
    expect(result.nodes["root"]?.completeness).toBe("truncated");
  });

  it("captures nested objects and JavaScript special primitive values", async () => {
    const releaseObject = vi.fn(async (objectId: string): Promise<void> => {
      if (objectId === "root") {
        throw new Error("release failure must not mask capture");
      }
    });
    const client: RemoteObjectClient = {
      getProperties: async (objectId: string): Promise<readonly RemotePropertyDescriptor[]> => objectId === "root"
        ? [
          { name: "child", value: { type: "object", objectId: "child", description: "Object" } },
          { name: "invalidString", value: { type: "string", description: "unavailable string" } },
          { name: "nan", value: { type: "number", unserializableValue: "NaN" } },
          { name: "nil", value: { type: "object", subtype: "null", value: null } },
          { name: "opaque", value: { type: "object", description: "Proxy" } },
          { name: "symbol", value: { type: "symbol", description: "Symbol(marker)" } },
        ]
        : [{ name: "value", value: { type: "boolean", value: true } }],
      releaseObject,
    };

    const result = await captureRemoteGraph(client, { type: "object", objectId: "root" }, {
      maxDepth: 3,
      maxProperties: 10,
      maxNodes: 4,
      maxBytes: 10_000,
    });

    expect(result.nodes["root"]?.properties).toMatchObject({
      child: { kind: "ref", nodeId: "root/child" },
      invalidString: { kind: "unavailable", description: "unavailable string" },
      nan: { kind: "special-number", value: "NaN" },
      nil: null,
      opaque: { kind: "unavailable", description: "Proxy" },
      symbol: { kind: "symbol", value: "Symbol(marker)" },
    });
    expect(result.nodes["root/child"]?.properties).toEqual({ value: true });
    expect(releaseObject).toHaveBeenCalledWith("root");
    expect(releaseObject).toHaveBeenCalledWith("child");
  });

  it("enforces property, node, and byte limits", async () => {
    const releaseObject = vi.fn(async (): Promise<void> => undefined);
    const client: RemoteObjectClient = {
      getProperties: async (): Promise<readonly RemotePropertyDescriptor[]> => [
        { name: "a", value: { type: "object", objectId: "child" } },
        { name: "b", value: { type: "number", value: 2 } },
      ],
      releaseObject,
    };
    const propertyLimited = await captureRemoteGraph(client, { type: "object", objectId: "root" }, {
      maxDepth: 3,
      maxProperties: 1,
      maxNodes: 1,
      maxBytes: 1_000,
    });
    const byteLimited = captureRemoteGraph(client, { type: "object", objectId: "root" }, {
      maxDepth: 3,
      maxProperties: 2,
      maxNodes: 3,
      maxBytes: 1,
    });

    expect(propertyLimited.nodes["root"]).toMatchObject({
      completeness: "truncated",
      omittedCount: 1,
      properties: { a: { kind: "unavailable", description: "node-limit" } },
    });
    await expect(byteLimited).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(releaseObject).toHaveBeenCalledWith("child");
  });

  it("does not retain a primitive value larger than the byte budget", async () => {
    const result = await captureRemoteGraph({
      getProperties: async (): Promise<readonly RemotePropertyDescriptor[]> => [{
        name: "value",
        value: { type: "string", value: "x".repeat(10_000) },
      }],
      releaseObject: async (): Promise<void> => undefined,
    }, { type: "object", objectId: "root" }, {
      maxDepth: 2,
      maxProperties: 2,
      maxNodes: 2,
      maxBytes: 128,
    });

    expect(result.completeness).toBe("truncated");
    expect(JSON.stringify(result)).not.toContain("x".repeat(100));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128);
  });

  it("hard-caps a long description and records its original length", async () => {
    const longDescription = "function format(module, level, ...args) {".padEnd(400, "z");
    const result = await captureRemoteGraph({
      getProperties: async (): Promise<readonly []> => [],
      releaseObject: async (): Promise<void> => undefined,
    }, { type: "function", objectId: "root", description: longDescription }, {
      maxDepth: 2,
      maxProperties: 2,
      maxNodes: 2,
      maxBytes: 10_000,
    });

    const node = result.nodes["root"];
    expect(node?.description?.length).toBe(256);
    expect(node?.description).toBe(longDescription.slice(0, 256));
    expect(node?.descriptionLength).toBe(400);
    expect(node?.completeness).toBe("truncated");
  });

  it("leaves a short description untouched and does not report it as truncated", async () => {
    const result = await captureRemoteGraph({
      getProperties: async (): Promise<readonly []> => [],
      releaseObject: async (): Promise<void> => undefined,
    }, { type: "object", objectId: "root", description: "short" }, {
      maxDepth: 2,
      maxProperties: 2,
      maxNodes: 2,
      maxBytes: 10_000,
    });

    expect(result.nodes["root"]).toMatchObject({ description: "short", completeness: "complete" });
    expect(result.nodes["root"]?.descriptionLength).toBeUndefined();
  });

  it("omits oversized object metadata from the bounded graph", async () => {
    const description = "metadata-sentinel".repeat(1000);
    const result = await captureRemoteGraph({
      getProperties: async (): Promise<readonly []> => [],
      releaseObject: async (): Promise<void> => undefined,
    }, { type: "object", objectId: "root", description }, {
      maxDepth: 2,
      maxProperties: 2,
      maxNodes: 2,
      maxBytes: 128,
    });

    expect(JSON.stringify(result)).not.toContain("metadata-sentinel");
    expect(result.completeness).toBe("truncated");
  });

  it("treats proxies as opaque without requesting their descriptors", async () => {
    const getProperties = vi.fn(async (): Promise<readonly []> => []);
    const releaseObject = vi.fn(async (): Promise<void> => undefined);
    const result = await captureRemoteGraph({ getProperties, releaseObject }, {
      type: "object",
      subtype: "proxy",
      objectId: "proxy",
      description: "Proxy(Object)",
    }, {
      maxDepth: 2,
      maxProperties: 2,
      maxNodes: 2,
      maxBytes: 1_000,
    });

    expect(getProperties).not.toHaveBeenCalled();
    expect(releaseObject).toHaveBeenCalledWith("proxy");
    expect(result.nodes["root"]?.completeness).toBe("unavailable");
    expect(result.completeness).toBe("truncated");
  });

  it("honors inspector completeness metadata for opaque ordinary objects", async () => {
    const getProperties = vi.fn(async (): Promise<readonly []> => []);
    const result = await captureRemoteGraph({
      getProperties,
      releaseObject: async (): Promise<void> => undefined,
    }, {
      type: "object",
      objectId: "opaque-runtime-value",
      completeness: "unavailable",
    }, {
      maxDepth: 2,
      maxProperties: 2,
      maxNodes: 2,
      maxBytes: 1_000,
    });

    expect(getProperties).not.toHaveBeenCalled();
    expect(result.nodes["root"]?.completeness).toBe("unavailable");
    expect(result.completeness).toBe("truncated");
  });

  it.each(["map", "set", "weakmap", "weakset", "promise", "date"])(
    "does not claim that hidden %s slots were captured completely",
    async (subtype) => {
      const result = await captureRemoteGraph({
        getProperties: async (): Promise<readonly []> => [],
        releaseObject: async (): Promise<void> => undefined,
      }, {
        type: "object",
        subtype,
        objectId: `opaque-${subtype}`,
        description: subtype,
      }, {
        maxDepth: 2,
        maxProperties: 2,
        maxNodes: 2,
        maxBytes: 1_000,
      });

      expect(result.nodes["root"]?.completeness).toBe("truncated");
      expect(result.completeness).toBe("truncated");
    },
  );

  it("rejects unsafe public graph limits before reading remote data", async () => {
    const getProperties = vi.fn(async (): Promise<readonly []> => []);
    const limits = {
      maxDepth: Number.POSITIVE_INFINITY,
      maxProperties: 2,
      maxNodes: 2,
      maxBytes: 1_000,
    };

    await expect(captureRemoteGraph({
      getProperties,
      releaseObject: async (): Promise<void> => undefined,
    }, { type: "object", objectId: "root" }, limits)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(getProperties).not.toHaveBeenCalled();
  });

  it("preserves own __proto__ descriptors without changing the graph prototype", async () => {
    const result = await captureRemoteGraph({
      getProperties: async (): Promise<readonly RemotePropertyDescriptor[]> => [{
        name: "__proto__",
        value: { type: "number", value: 7 },
      }],
      releaseObject: async (): Promise<void> => undefined,
    }, { type: "object", objectId: "root" }, {
      maxDepth: 2,
      maxProperties: 2,
      maxNodes: 2,
      maxBytes: 1_000,
    });
    const properties = result.nodes["root"]?.properties;

    expect(properties === undefined ? false : Object.hasOwn(properties, "__proto__")).toBe(true);
    expect(properties?.["__proto__"]).toBe(7);
  });

  it("captures primitive roots without materializing remote objects", async () => {
    const getProperties = vi.fn(async (): Promise<readonly []> => []);
    const releaseObject = vi.fn(async (): Promise<void> => undefined);
    const result = await captureRemoteValues({ getProperties, releaseObject }, {
      count: { type: "number", value: 3 },
      missing: { type: "undefined" },
    }, {
      maxDepth: 1,
      maxProperties: 1,
      maxNodes: 1,
      maxBytes: 100,
    });

    expect(result).toEqual({
      completeness: "complete",
      nodes: {},
      roots: { count: 3, missing: { kind: "undefined" } },
    });
    expect(getProperties).not.toHaveBeenCalled();
    expect(releaseObject).not.toHaveBeenCalled();
  });

  it("captures roots in the caller's insertion order, not re-sorted alphabetically", async () => {
    const getProperties = vi.fn(async (_objectId: string): Promise<readonly []> => []);
    const releaseObject = vi.fn(async (): Promise<void> => undefined);

    const result = await captureRemoteValues({ getProperties, releaseObject }, {
      zebra: { type: "object", objectId: "zebra-obj" },
      alpha: { type: "object", objectId: "alpha-obj" },
    }, {
      maxDepth: 2,
      maxProperties: 10,
      maxNodes: 10,
      maxBytes: 10_000,
    });

    // Node ids are now the path used to reach a value (here, just its own
    // root key) rather than a discovery-order counter, so the fetch order
    // itself -- not the assigned id -- is what proves "zebra" (inserted
    // first) is walked before "alpha" even though "alpha" sorts first.
    expect(getProperties.mock.calls.map(([objectId]) => objectId)).toEqual(["zebra-obj", "alpha-obj"]);
    expect(result.roots["zebra"]).toEqual({ kind: "ref", nodeId: "zebra" });
    expect(result.roots["alpha"]).toEqual({ kind: "ref", nodeId: "alpha" });
  });

  it("assigns the same node id to the same reachable value across two separate captures", async () => {
    // This is the cross-step regression itself: a discovery-order counter
    // (the old `n${Object.keys(context.nodes).length}` scheme) would assign
    // `target` a different id here purely because "extra" -- an unrelated
    // root that happens to sort/iterate earlier -- grew new properties
    // between the two captures and so claims more node slots first. A
    // path-addressed id must depend only on how `target` itself is reached,
    // not on what else was captured earlier in the same call.
    const client: RemoteObjectClient = {
      getProperties: async (objectId: string): Promise<readonly RemotePropertyDescriptor[]> => (
        objectId === "extra-obj"
          ? [{ name: "a", value: { type: "number", value: 1 } }]
          : []
      ),
      releaseObject: async (): Promise<void> => undefined,
    };
    const limits = { maxDepth: 3, maxProperties: 10, maxNodes: 20, maxBytes: 10_000 };

    const stepZero = await captureRemoteValues(client, {
      target: { type: "object", objectId: "target-obj" },
    }, limits);
    const stepThree = await captureRemoteValues(client, {
      extra: { type: "object", objectId: "extra-obj" },
      target: { type: "object", objectId: "target-obj" },
    }, limits);

    expect(stepZero.roots["target"]).toEqual({ kind: "ref", nodeId: "target" });
    expect(stepThree.roots["target"]).toEqual(stepZero.roots["target"]);
  });

  it("caps one root's share of the node budget so a later root is not starved", async () => {
    const getProperties = vi.fn(async (objectId: string): Promise<readonly RemotePropertyDescriptor[]> => {
      if (objectId === "big") {
        return Array.from({ length: 10 }, (_unused, index) => ({
          name: `child${index.toString()}`,
          value: { type: "object", objectId: `big-child-${index.toString()}` },
        }));
      }
      if (objectId === "small") {
        return [{ name: "value", value: { type: "string", value: "42" } }];
      }
      return [];
    });
    const releaseObject = vi.fn(async (): Promise<void> => undefined);

    // "big" is inserted first and would alone exhaust every one of the 6
    // allowed nodes (1 for itself + up to 10 children) if it were not capped.
    const result = await captureRemoteValues({ getProperties, releaseObject }, {
      big: { type: "object", objectId: "big" },
      small: { type: "object", objectId: "small" },
    }, {
      maxDepth: 3,
      maxProperties: 20,
      maxNodes: 6,
      maxBytes: 100_000,
    });

    expect(result.completeness).toBe("truncated");
    expect(result.roots["big"]).toEqual({ kind: "ref", nodeId: "big" });
    // "big" only got its fair share (4 of the 6 nodes: itself + 3 children).
    expect(result.nodes["big"]?.properties["child3"]).toEqual({ kind: "unavailable", description: "node-limit" });
    // "small", processed second, still got a real node and its real value --
    // it was not starved down to node-limit by "big" going first.
    expect(result.roots["small"]).toEqual({ kind: "ref", nodeId: "small" });
    expect(result.nodes["small"]?.properties).toEqual({ value: "42" });
  });

  it("releases a materialized object when descriptor capture fails", async () => {
    const releaseObject = vi.fn(async (): Promise<void> => undefined);
    const client: RemoteObjectClient = {
      getProperties: async (): Promise<readonly []> => {
        throw new Error("descriptor failure");
      },
      releaseObject,
    };

    await expect(captureRemoteGraph(client, { type: "object", objectId: "root" }, {
      maxDepth: 1,
      maxProperties: 1,
      maxNodes: 1,
      maxBytes: 100,
    })).rejects.toThrow("descriptor failure");
    expect(releaseObject).toHaveBeenCalledWith("root");
  });
});
